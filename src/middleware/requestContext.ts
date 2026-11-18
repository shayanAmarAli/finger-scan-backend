import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

import type { Logger } from '../lib/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Assigns a request id (honours a well-formed incoming X-Request-Id),
 * echoes it in the response and logs one line per request: method, path,
 * status, duration. Never logs headers, bodies or query strings.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info('request', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
      });
    });
    next();
  };
}
