// Fetch wrapper for the optional backend.
//
// - The access token lives only in this module's memory (never localStorage).
// - The refresh token is an HttpOnly cookie the browser sends to /api/auth only.
// - A 401 from an expired access token triggers one silent refresh, then a retry.
// - Refreshes are single-flight, and serialized across tabs with the Web Locks API so
//   two tabs never rotate the same refresh token at once.
//
// Nothing in the editor calls this; only the account / saved-project features do.

const BASE = (import.meta.env?.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

let accessToken = null;
let sessionListener = (_user) => {};
// Bumped on every sign-in, so a slow refresh that started before it can't sign the
// new session out when its (stale) "no session" answer finally arrives.
let epoch = 0;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function setAccessToken(token) {
  accessToken = token;
  epoch++;
}

/** Called with the user (or null) whenever a refresh changes who is signed in. */
export function setSessionListener(fn) {
  sessionListener = fn;
}

async function raw(path, { method = 'GET', body, auth = true, csrf = false, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (csrf) headers['X-Scarlet-CSRF'] = '1';

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', "Can't reach the server. Check your connection and try again.");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? `HTTP_${res.status}`,
      data?.error?.message ?? `Request failed (${res.status}).`,
      data?.error?.details,
    );
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let refreshing = null;

/** Exchange the refresh cookie for a new access token. Resolves to the user, or null if signed out. */
export function refreshSession() {
  refreshing ??= (async () => {
    const startedAt = epoch;
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await raw('/auth/refresh', { method: 'POST', auth: false, csrf: true });
          accessToken = data.accessToken;
          sessionListener(data.user);
          return data.user;
        } catch (err) {
          if (err.code === 'REFRESH_RACE') {
            await sleep(300 * (attempt + 1));
            continue;
          }
          if (err.status === 401) {
            if (epoch !== startedAt) return null; // someone signed in meanwhile; keep that session
            accessToken = null;
            sessionListener(null);
            return null;
          }
          throw err;
        }
      }
      return null;
    };
    return typeof navigator !== 'undefined' && navigator.locks?.request
      ? navigator.locks.request('scarlet-auth-refresh', run)
      : run();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

const REFRESHABLE = new Set(['TOKEN_EXPIRED', 'TOKEN_MISSING', 'TOKEN_INVALID']);

export async function api(path, opts = {}) {
  try {
    return await raw(path, opts);
  } catch (err) {
    if (err.status === 401 && opts.auth !== false && REFRESHABLE.has(err.code)) {
      const user = await refreshSession();
      if (!user) throw new ApiError(401, 'SIGNED_OUT', 'You have been signed out. Sign in again to keep saving.');
      return raw(path, opts);
    }
    if (err.status === 401 && err.code === 'SESSION_REVOKED') {
      accessToken = null;
      sessionListener(null);
    }
    throw err;
  }
}

/**
 * GET a binary resource from the API with the access token (refreshing it once if needed).
 * Resolves to the Response; throws ApiError for error statuses.
 */
export async function authorizedFetch(path, { signal } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(BASE + path, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        credentials: 'include',
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ApiError(0, 'NETWORK', "Can't reach the server. Check your connection and try again.");
    }
    if (res.ok && res.body) return res;
    const data = await res.json().catch(() => null);
    const err = new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? `Request failed (${res.status}).`);
    if (attempt === 0 && res.status === 401 && REFRESHABLE.has(err.code) && (await refreshSession())) continue;
    throw err;
  }
  throw new ApiError(401, 'SIGNED_OUT', 'You have been signed out.');
}

export const apiBase = BASE;
