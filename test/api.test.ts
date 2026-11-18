import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { memoryLogger, probe, TEST_APP_KEY, testApp } from './helpers/app.js';

describe('GET /health (liveness)', () => {
  it('returns ok without needing an app key or Supabase', async () => {
    const { app } = testApp({ readiness: probe(new Error('down')) });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', version: '9.9.9-test' });
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });
});

describe('GET /health/ready (readiness)', () => {
  it('200 when database and private bucket are OK', async () => {
    const { app } = testApp();
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ready',
      checks: { database: true, storageBucket: true },
    });
  });

  it('database failure → controlled 503 with per-check booleans only', async () => {
    const { app } = testApp({
      readiness: probe({ ok: false, checks: { database: false, storageBucket: true } }),
    });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'unavailable',
      checks: { database: false, storageBucket: true },
    });
  });

  it('probe throwing (e.g. network error) → 503, no internals leaked', async () => {
    const { app } = testApp({
      readiness: probe(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2')),
    });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
  });
});

describe('app key (no user logins: the key identifies the app)', () => {
  it('valid key → 200', async () => {
    const { app } = testApp();
    const res = await request(app).get('/api/ping').set('X-App-Key', TEST_APP_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('missing key → 401', async () => {
    const { app } = testApp();
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({
      code: 'unauthorized',
      message: 'Missing or invalid app key.',
    });
  });

  it('invalid key → 401 (wrong value, wrong length, empty, case changed)', async () => {
    const { app } = testApp();
    for (const key of ['wrong', `${TEST_APP_KEY}x`, '', TEST_APP_KEY.toUpperCase()]) {
      const res = await request(app).get('/api/ping').set('X-App-Key', key);
      expect(res.status, `key "${key}"`).toBe(401);
    }
  });

  it('key in a query string or Authorization header is not accepted', async () => {
    const { app } = testApp();
    expect((await request(app).get(`/api/ping?key=${TEST_APP_KEY}`)).status).toBe(401);
    expect(
      (await request(app).get('/api/ping').set('Authorization', `Bearer ${TEST_APP_KEY}`))
        .status,
    ).toBe(401);
  });

  it('unknown /api routes are also protected (401 before 404)', async () => {
    const { app } = testApp();
    expect((await request(app).get('/api/nothing-here')).status).toBe(401);
    expect(
      (await request(app).get('/api/nothing-here').set('X-App-Key', TEST_APP_KEY)).status,
    ).toBe(404);
  });
});

describe('error handling', () => {
  it('unknown route → JSON 404 with request id', async () => {
    const { app } = testApp();
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('malformed JSON → 400 invalid_json', async () => {
    const { app } = testApp();
    const res = await request(app)
      .post('/api/ping')
      .set('X-App-Key', TEST_APP_KEY)
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('oversized JSON body → 413', async () => {
    const { app } = testApp();
    const res = await request(app)
      .post('/api/ping')
      .set('X-App-Key', TEST_APP_KEY)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(20_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('does not advertise Express', async () => {
    const { app } = testApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('request ids and logging', () => {
  it('honours a well-formed X-Request-Id, replaces a malformed one', async () => {
    const { app } = testApp();
    const good = await request(app).get('/health').set('X-Request-Id', 'abc12345-req');
    expect(good.headers['x-request-id']).toBe('abc12345-req');
    const bad = await request(app).get('/health').set('X-Request-Id', '<script>');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs method/path/status but never the app key, headers or query', async () => {
    const logger = memoryLogger();
    const { app } = testApp({ logger });
    await request(app).get('/api/ping?token=abc').set('X-App-Key', TEST_APP_KEY);
    await request(app).get('/api/ping').set('X-App-Key', 'wrong-key-value');
    const all = logger.lines.join('\n');
    expect(all).toContain('"path":"/api/ping"');
    expect(all).toContain('"status":401');
    expect(all).not.toContain(TEST_APP_KEY);
    expect(all).not.toContain('wrong-key-value');
    expect(all).not.toContain('token=abc');
  });
});
