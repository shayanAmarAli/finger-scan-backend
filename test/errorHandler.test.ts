import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AppError } from '../src/lib/errors.js';
import { errorHandler, notFound } from '../src/middleware/errorHandler.js';
import { requestContext } from '../src/middleware/requestContext.js';
import { memoryLogger } from './helpers/app.js';

function appWith(route: express.RequestHandler) {
  const logger = memoryLogger();
  const app = express();
  app.use(requestContext(logger));
  app.get('/x', route);
  app.use(notFound);
  app.use(errorHandler(logger));
  return { app, logger };
}

describe('errorHandler', () => {
  it('unexpected error → generic 500; details only in server log', async () => {
    const { app, logger } = appWith(() => {
      throw new Error('db password=hunter2 at 10.0.0.5');
    });
    const res = await request(app).get('/x');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'internal_error', message: 'Something went wrong.' },
      requestId: res.headers['x-request-id'],
    });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    const logged = logger.lines.find((l) => l.includes('unhandled error'));
    expect(logged).toBeDefined();
    expect(logged).toContain(res.headers['x-request-id']);
  });

  it('async rejection is caught too (Express 5)', async () => {
    const { app } = appWith(async () => {
      throw new Error('async failure');
    });
    const res = await request(app).get('/x');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
  });

  it('AppError is returned as-is with its status and code', async () => {
    const { app, logger } = appWith(() => {
      throw AppError.serviceUnavailable('Storage is temporarily unavailable.');
    });
    const res = await request(app).get('/x');
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'service_unavailable',
      message: 'Storage is temporarily unavailable.',
    });
    expect(logger.lines.some((l) => l.includes('unhandled error'))).toBe(false);
  });

  it('non-Error throwables are handled', async () => {
    const { app } = appWith(() => {
      throw 'a string'; // eslint-disable-line no-throw-literal
    });
    const res = await request(app).get('/x');
    expect(res.status).toBe(500);
  });
});
