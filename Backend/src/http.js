// Shared HTTP helpers: typed errors, validation, the JSON error handler.

import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'Project') => new HttpError(404, 'NOT_FOUND', `${what} not found`);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Any malformed id is treated exactly like someone else's id: 404. */
export function assertUuid(id, what) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw notFound(what);
  return id;
}

/** Parse `data` with a zod schema or throw a 400 with the issues. */
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw result.error;
  return result.data;
}

// Never echo request bodies (they may hold passwords) into logs.
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION',
        message: 'Some fields are invalid.',
        details: err.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body.' } });
  }
  console.error(`[api] ${req.method} ${req.path} failed:`, err?.message ?? err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side.' } });
}
