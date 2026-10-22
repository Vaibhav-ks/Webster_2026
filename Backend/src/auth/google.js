// Google Identity Services ID-token verification. google-auth-library checks the
// signature against Google's published keys, the issuer, the audience (our client
// ID) and the expiry. We only trust `sub` as the Google identity; the email is used
// for display / matching and only when Google says it is verified.

import { OAuth2Client } from 'google-auth-library';
import { HttpError } from '../http.js';

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export function createGoogleVerifier(clientId) {
  if (!clientId) return null;
  const client = new OAuth2Client(clientId);
  return async function verifyGoogleCredential(credential) {
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload();
    } catch {
      throw new HttpError(401, 'GOOGLE_INVALID', 'Google sign-in could not be verified. Please try again.');
    }
    if (!payload?.sub || !ISSUERS.has(payload.iss) || payload.aud !== clientId) {
      throw new HttpError(401, 'GOOGLE_INVALID', 'Google sign-in could not be verified. Please try again.');
    }
    return {
      sub: payload.sub,
      email: payload.email ? String(payload.email).trim().toLowerCase() : null,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
    };
  };
}
