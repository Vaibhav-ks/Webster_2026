// /api/auth/*
//
//   POST /register        email + password            -> access token, refresh cookie
//   POST /login           email + password            -> access token, refresh cookie
//   POST /google          Google ID token             -> access token, or 409 LINK_REQUIRED
//   POST /google/link     (signed in) Google ID token + current password -> links Google
//   POST /refresh         (cookie + CSRF)             -> rotated refresh cookie + access token
//   POST /logout          (cookie + CSRF)             -> revokes the session family
//   GET  /me              (signed in)                 -> current user
//
// Accounts: one person = one row in `users`, with a password, a Google identity, or
// both. Matching emails are NEVER merged automatically: linking Google to an existing
// account requires signing in to that account and re-entering its password.

import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../http.js';
import { tx } from '../db.js';
import { hashPassword, verifyPassword, verifyDummy, normalizeEmail, PASSWORD_MIN, PASSWORD_MAX } from './passwords.js';
import { createSession, rotateSession, revokeByToken } from './tokens.js';
import { requireAuth, requireCsrf } from './middleware.js';

const email = z
  .string()
  .max(254)
  .transform(normalizeEmail)
  .pipe(z.string().email('Enter a valid email address.'));
const password = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
  .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters.`);

const RegisterBody = z.object({
  email,
  password,
  displayName: z.string().trim().min(1).max(100).optional(),
});
const LoginBody = z.object({ email, password: z.string().min(1).max(PASSWORD_MAX) });
const GoogleBody = z.object({ credential: z.string().min(20).max(8192) });
const LinkBody = GoogleBody.extend({ password: z.string().min(1).max(PASSWORD_MAX).optional() });

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    emailVerified: u.email_verified,
    hasPassword: Boolean(u.password_hash),
    googleLinked: Boolean(u.google_sub),
  };
}

export function createAuthRouter({ pool, config, tokens, verifyGoogle, limiters }) {
  const router = Router();
  const { auth } = config;
  const cookieName = auth.cookieSecure ? '__Secure-sr_rt' : 'sr_rt';
  const cookieOptions = {
    httpOnly: true,
    secure: auth.cookieSecure,
    sameSite: 'strict',
    path: '/api/auth',
  };
  const csrf = requireCsrf(auth);
  const signedIn = requireAuth({ tokens, pool });

  async function issue(res, user, req) {
    const session = await createSession(pool, {
      userId: user.id,
      userAgent: req.get('user-agent'),
      ttlDays: auth.refreshTtlDays,
    });
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    return respondWithSession(res, user, session);
  }

  async function respondWithSession(res, user, session) {
    res.cookie(cookieName, session.token, { ...cookieOptions, expires: session.expiresAt });
    const accessToken = await tokens.signAccess({ userId: user.id, familyId: session.familyId });
    res.set('Cache-Control', 'no-store');
    return res.json({ accessToken, expiresIn: tokens.accessTtlS, user: publicUser(user) });
  }

  const getUser = async (db, id) => (await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];

  // ------------------------------------------------------------ email + password
  router.post('/register', limiters.auth, async (req, res) => {
    const body = parse(RegisterBody, req.body);
    const hash = await hashPassword(body.password);
    const displayName = body.displayName ?? body.email.split('@')[0].slice(0, 100);
    let user;
    try {
      ({ rows: [user] } = await pool.query(
        `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING *`,
        [body.email, displayName, hash],
      ));
    } catch (err) {
      if (err.code === '23505') {
        throw new HttpError(409, 'EMAIL_IN_USE', 'An account with this email already exists. Sign in instead.');
      }
      throw err;
    }
    res.status(201);
    return issue(res, user, req);
  });

  router.post('/login', limiters.auth, limiters.loginEmail, async (req, res) => {
    const body = parse(LoginBody, req.body);
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [body.email]);
    const user = rows[0];
    const ok = user?.password_hash ? await verifyPassword(user.password_hash, body.password) : await verifyDummy(body.password);
    if (!ok) {
      // Same answer whether the email is unknown, Google-only, or the password is wrong.
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    return issue(res, user, req);
  });

  // ------------------------------------------------------------ Google
  function googleEnabled() {
    if (!verifyGoogle) throw new HttpError(503, 'GOOGLE_DISABLED', 'Google sign-in is not configured.');
  }

  router.post('/google', limiters.auth, async (req, res) => {
    googleEnabled();
    const { credential } = parse(GoogleBody, req.body);
    const g = await verifyGoogle(credential);

    const bySub = (await pool.query('SELECT * FROM users WHERE google_sub = $1', [g.sub])).rows[0];
    if (bySub) return issue(res, bySub, req);

    if (!g.email || !g.emailVerified) {
      throw new HttpError(403, 'GOOGLE_EMAIL_UNVERIFIED', 'Your Google account email is not verified.');
    }
    const byEmail = (await pool.query('SELECT * FROM users WHERE email = $1', [g.email])).rows[0];
    if (byEmail) {
      // Never merge on email alone. The owner must prove access to the existing account.
      throw new HttpError(
        409,
        'LINK_REQUIRED',
        byEmail.password_hash
          ? 'An account with this email already exists. Sign in with your password to link Google.'
          : 'This email is already used by an account that signs in with a different Google account.',
        { email: g.email, hasPassword: Boolean(byEmail.password_hash) },
      );
    }

    let user;
    try {
      ({ rows: [user] } = await pool.query(
        `INSERT INTO users (email, email_verified, display_name, google_sub) VALUES ($1, true, $2, $3) RETURNING *`,
        [g.email, (g.name || g.email.split('@')[0]).slice(0, 100), g.sub],
      ));
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'CONFLICT', 'Account was just created elsewhere. Please try again.');
      throw err;
    }
    res.status(201);
    return issue(res, user, req);
  });

  router.post('/google/link', limiters.auth, signedIn, async (req, res) => {
    googleEnabled();
    const body = parse(LinkBody, req.body);
    const user = await tx(pool, async (client) => {
      const current = (await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.auth.userId])).rows[0];
      if (!current) throw new HttpError(401, 'TOKEN_INVALID', 'Not signed in.');

      // Step-up: a stolen access token alone must not be able to attach someone else's Google.
      if (current.password_hash) {
        if (!body.password || !(await verifyPassword(current.password_hash, body.password))) {
          throw new HttpError(401, 'INVALID_CREDENTIALS', 'Password is incorrect.');
        }
      }

      const g = await verifyGoogle(body.credential);
      if (current.google_sub === g.sub) return current; // already linked to this Google account
      if (current.google_sub) {
        throw new HttpError(409, 'ALREADY_LINKED', 'A different Google account is already linked.');
      }
      if (!g.emailVerified) throw new HttpError(403, 'GOOGLE_EMAIL_UNVERIFIED', 'Your Google account email is not verified.');

      const taken = await client.query('SELECT 1 FROM users WHERE google_sub = $1', [g.sub]);
      if (taken.rows.length) {
        throw new HttpError(409, 'GOOGLE_IN_USE', 'That Google account is already linked to another account.');
      }
      const sameEmail = g.email && g.email === current.email;
      return (
        await client.query(
          `UPDATE users SET google_sub = $2, email_verified = email_verified OR $3, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [current.id, g.sub, sameEmail],
        )
      ).rows[0];
    });
    res.json({ user: publicUser(user) });
  });

  // ------------------------------------------------------------ session lifecycle
  router.post('/refresh', limiters.refresh, csrf, async (req, res) => {
    const token = req.cookies?.[cookieName];
    if (!token) throw new HttpError(401, 'NO_SESSION', 'Not signed in.');
    const result = await tx(pool, (client) =>
      rotateSession(client, token, { ttlDays: auth.refreshTtlDays, userAgent: req.get('user-agent') }),
    );
    if (!result.ok) {
      if (result.reason === 'race') {
        throw new HttpError(409, 'REFRESH_RACE', 'Session was refreshed by another tab; retry.');
      }
      res.clearCookie(cookieName, cookieOptions);
      throw new HttpError(401, result.reason === 'reuse' ? 'SESSION_REUSED' : 'NO_SESSION', 'Please sign in again.');
    }
    const user = await getUser(pool, result.userId);
    if (!user) throw new HttpError(401, 'NO_SESSION', 'Please sign in again.');
    return respondWithSession(res, user, result);
  });

  router.post('/logout', csrf, async (req, res) => {
    const token = req.cookies?.[cookieName];
    if (token) await revokeByToken(pool, token);
    res.clearCookie(cookieName, cookieOptions);
    res.status(204).end();
  });

  router.get('/me', signedIn, async (req, res) => {
    const user = await getUser(pool, req.auth.userId);
    if (!user) throw new HttpError(401, 'TOKEN_INVALID', 'Not signed in.');
    res.set('Cache-Control', 'no-store');
    res.json({ user: publicUser(user) });
  });

  return router;
}
