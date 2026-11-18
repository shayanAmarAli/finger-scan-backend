import type { ErrorRequestHandler, RequestHandler } from 'express';

import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

/** 404 for any route not matched. */
export const notFound: RequestHandler = (_req, _res, next) => next(AppError.notFound());

/**
 * Central error handler. Response shape:
 * `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`.
 *
 * Only [AppError]s and well-known body-parser errors are shown to clients;
 * everything else becomes a generic 500 and is logged server-side (message
 * only — no request data).
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const known = toAppError(err);
    if (!known) {
      logger.error('unhandled error', {
        requestId: req.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const e = known ?? new AppError(500, 'internal_error', 'Something went wrong.');
    res.status(e.status).json({
      error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
      requestId: req.id,
    });
  };
}

function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  // Errors raised by express.json() / raw-body.
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') {
    return new AppError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  if (type === 'entity.too.large') {
    return new AppError(413, 'payload_too_large', 'The request body is too large.');
  }
  return null;
}
