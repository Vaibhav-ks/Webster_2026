import argon2 from 'argon2';

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1).
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function hashPassword(password) {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash;
/** Spend the same time as a real check when the account doesn't exist. */
export async function verifyDummy(password) {
  dummyHash ??= await argon2.hash('scarlet-rewrite-timing-equaliser', OPTIONS);
  await verifyPassword(dummyHash, password);
  return false;
}

/** Trim + lowercase + Unicode NFC. Gmail dots/plus are NOT stripped (they can be distinct mailboxes elsewhere). */
export function normalizeEmail(email) {
  return String(email ?? '').normalize('NFC').trim().toLowerCase();
}
