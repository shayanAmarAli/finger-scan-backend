import { createHash, timingSafeEqual } from 'node:crypto';

import type { RequestHandler } from 'express';

import { AppError } from '../lib/errors.js';

export const APP_KEY_HEADER = 'x-app-key';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Requires the shared app key in `X-App-Key`. There are no user logins in
 * this product: the key identifies the app, not a person.
 *
 * Comparison is constant-time (on SHA-256 digests, so length differences
 * don't leak either).
 */
export function requireAppKey(expectedKey: string): RequestHandler {
  const expected = digest(expectedKey);
  return (req, _res, next) => {
    const provided = req.get(APP_KEY_HEADER);
    if (!provided || !timingSafeEqual(digest(provided), expected)) {
      next(AppError.unauthorized());
      return;
    }
    next();
  };
}
