import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';

import { AppError } from '../lib/errors.js';

/**
 * Security headers for a JSON-only API that browsers never need to render:
 * no scripts/frames/embedding, HSTS, no MIME sniffing, no referrer.
 *
 * CORS is intentionally NOT enabled: the only client is the mobile app,
 * which doesn't need CORS, so browser pages on other origins can't read
 * any response.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
  });
}

/** API responses (quality reports, submission ids) must not be cached. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * Per-client-IP rate limit (`trust proxy` gives the real IP behind
 * Railway's proxy). Applied BEFORE the app-key check so key guessing is
 * limited too. Over the limit → 429 `rate_limited` + `RateLimit` /
 * `Retry-After` headers.
 */
export function rateLimiter(opts: { windowMs: number; max: number; name: string }): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: opts.name,
    handler: (_req, _res, next) => {
      next(
        new AppError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.'),
      );
    },
  });
}
