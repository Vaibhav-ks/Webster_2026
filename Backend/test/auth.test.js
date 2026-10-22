import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, register, browser, bearer, ORIGIN } from './helpers.js';

let t;
before(async () => (t = await setup()));
after(() => t.teardown());

const csrf = { Origin: ORIGIN, 'X-Scarlet-CSRF': '1' };
const refresh = (agent) => agent.post('/api/auth/refresh').set(csrf);

test('register normalizes email, hashes password, rejects duplicates case-insensitively', async () => {
  const res = await browser(t.app)
    .post('/api/auth/register')
    .send({ email: '  Alice@Example.COM ', password: 'longenough1', displayName: 'Alice' })
    .expect(201);
  assert.equal(res.body.user.email, 'alice@example.com');
  assert.equal(res.body.user.hasPassword, true);
  assert.ok(res.body.accessToken);
  assert.match(res.headers['set-cookie'].join(';'), /sr_rt=.*HttpOnly.*SameSite=Strict/i);
  assert.match(res.headers['set-cookie'].join(';'), /Path=\/api\/auth/);

  const row = (await t.pool.query(`SELECT password_hash FROM users WHERE email = 'alice@example.com'`)).rows[0];
  assert.match(row.password_hash, /^\$argon2id\$/);
  assert.ok(!row.password_hash.includes('longenough1'));

  const dup = await browser(t.app).post('/api/auth/register').send({ email: 'ALICE@example.com', password: 'otherpass1' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'EMAIL_IN_USE');
});

test('register validates input', async () => {
  const bad = await browser(t.app).post('/api/auth/register').send({ email: 'not-an-email', password: 'short' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION');
});

test('login: right password works, wrong password and unknown email give the same answer', async () => {
  const u = await register(t.app);
  const ok = await browser(t.app).post('/api/auth/login').send({ email: u.email.toUpperCase(), password: u.password });
  assert.equal(ok.status, 200);
  const wrong = await browser(t.app).post('/api/auth/login').send({ email: u.email, password: 'nope-nope' });
  const unknown = await browser(t.app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'nope-nope' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('protected routes need a valid access token', async () => {
  await request(t.app).get('/api/auth/me').expect(401);
  await request(t.app).get('/api/auth/me').set(bearer('garbage.token.here')).expect(401);
  await request(t.app).get('/api/projects').expect(401);
  const u = await register(t.app);
  const me = await request(t.app).get('/api/auth/me').set(bearer(u.token)).expect(200);
  assert.equal(me.body.user.email, u.email);
});

test('refresh rotates the token; replaying an old token revokes the whole session', async () => {
  const u = await register(t.app);

  const r1 = await refresh(u.agent).expect(200);
  assert.ok(r1.body.accessToken);

  // The rotated-out token, replayed from another client after the race window.
  await t.pool.query(`UPDATE auth_sessions SET revoked_at = now() - interval '1 minute' WHERE revoked_reason = 'rotated'`);
  const thief = await request(t.app).post('/api/auth/refresh').set(csrf).set('Cookie', `sr_rt=${u.refreshCookie}`);
  assert.equal(thief.status, 401);
  assert.equal(thief.body.error.code, 'SESSION_REUSED');

  // The legitimate user's newer token and access token are now dead too.
  await refresh(u.agent).expect(401);
  await request(t.app).get('/api/auth/me').set(bearer(r1.body.accessToken)).expect(401);
});

test('two tabs refreshing at once: the late one is told to retry, not logged out', async () => {
  const u = await register(t.app);
  await refresh(u.agent).expect(200);
  const late = await request(t.app).post('/api/auth/refresh').set(csrf).set('Cookie', `sr_rt=${u.refreshCookie}`);
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'REFRESH_RACE');
  await refresh(u.agent).expect(200); // the session survived
});

test('refresh and logout require our origin and the CSRF header', async () => {
  const u = await register(t.app);
  await u.agent.post('/api/auth/refresh').expect(403);
  await u.agent.post('/api/auth/refresh').set({ Origin: 'https://evil.example', 'X-Scarlet-CSRF': '1' }).expect(403);
  await u.agent.post('/api/auth/refresh').set({ Origin: ORIGIN }).expect(403);
  await u.agent.post('/api/auth/logout').set({ Origin: 'https://evil.example', 'X-Scarlet-CSRF': '1' }).expect(403);
  await refresh(u.agent).expect(200);
});

test('logout revokes the refresh token and outstanding access tokens', async () => {
  const u = await register(t.app);
  await u.agent.post('/api/auth/logout').set(csrf).expect(204);
  await request(t.app).get('/api/auth/me').set(bearer(u.token)).expect(401);
  await refresh(u.agent).expect(401);
});

test('google: new user, returning user (by sub), and unverified email', async () => {
  t.google.add('cred-new', { sub: 'g-100', email: 'gina@example.com', name: 'Gina' });
  const first = await browser(t.app).post('/api/auth/google').send({ credential: 'cred-new'.padEnd(30, 'x') });
  assert.equal(first.status, 401, 'unknown credential (bad signature) is rejected');

  t.google.add('cred-new-xxxxxxxxxxxxxxxxxxxxxx', { sub: 'g-100', email: 'gina@example.com', name: 'Gina' });
  const created = await browser(t.app).post('/api/auth/google').send({ credential: 'cred-new-xxxxxxxxxxxxxxxxxxxxxx' }).expect(201);
  assert.equal(created.body.user.googleLinked, true);
  assert.equal(created.body.user.hasPassword, false);

  t.google.add('cred-again-xxxxxxxxxxxxxxxxxxxx', { sub: 'g-100', email: 'gina@example.com' });
  const again = await browser(t.app).post('/api/auth/google').send({ credential: 'cred-again-xxxxxxxxxxxxxxxxxxxx' }).expect(200);
  assert.equal(again.body.user.id, created.body.user.id);

  t.google.add('cred-unverified-xxxxxxxxxxxxxxx', { sub: 'g-101', email: 'u@example.com', emailVerified: false });
  const unv = await browser(t.app).post('/api/auth/google').send({ credential: 'cred-unverified-xxxxxxxxxxxxxxx' });
  assert.equal(unv.status, 403);
});

test('google never merges into an existing email account; linking needs the password', async () => {
  const u = await register(t.app, 'link-me@example.com', 'my password 1');
  const cred = 'cred-link-xxxxxxxxxxxxxxxxxxxxx';
  t.google.add(cred, { sub: 'g-200', email: 'link-me@example.com' });

  const attempt = await browser(t.app).post('/api/auth/google').send({ credential: cred });
  assert.equal(attempt.status, 409);
  assert.equal(attempt.body.error.code, 'LINK_REQUIRED');
  assert.equal(attempt.headers['set-cookie'], undefined, 'no session issued');
  assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'link-me@example.com'`)).rows[0].n, 1);

  // Signed in, but without (or with a wrong) password: refused.
  await request(t.app).post('/api/auth/google/link').set(bearer(u.token)).send({ credential: cred }).expect(401);
  await request(t.app).post('/api/auth/google/link').set(bearer(u.token)).send({ credential: cred, password: 'wrong' }).expect(401);

  const linked = await request(t.app)
    .post('/api/auth/google/link')
    .set(bearer(u.token))
    .send({ credential: cred, password: 'my password 1' })
    .expect(200);
  assert.equal(linked.body.user.googleLinked, true);
  assert.equal(linked.body.user.emailVerified, true);

  // Now Google signs in to the same single account.
  const viaGoogle = await browser(t.app).post('/api/auth/google').send({ credential: cred }).expect(200);
  assert.equal(viaGoogle.body.user.id, u.user.id);
});

test('a Google identity can belong to only one account', async () => {
  const a = await register(t.app);
  const b = await register(t.app);
  const cred = 'cred-shared-xxxxxxxxxxxxxxxxxxx';
  t.google.add(cred, { sub: 'g-300', email: 'shared@example.com' });
  await request(t.app).post('/api/auth/google/link').set(bearer(a.token)).send({ credential: cred, password: a.password }).expect(200);
  const second = await request(t.app).post('/api/auth/google/link').set(bearer(b.token)).send({ credential: cred, password: b.password });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'GOOGLE_IN_USE');
});

test('login is rate limited per email', async () => {
  const limited = await setup({ rateLimits: { auth: 1000, loginEmail: 3, refresh: 1000 } });
  try {
    for (let i = 0; i < 3; i++) {
      await browser(limited.app).post('/api/auth/login').send({ email: 'x@example.com', password: 'wrong-pass' }).expect(401);
    }
    const blocked = await browser(limited.app).post('/api/auth/login').send({ email: 'X@example.com', password: 'wrong-pass' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  } finally {
    await limited.teardown();
  }
});
