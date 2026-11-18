import { createServer } from 'node:http';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { applyTimeouts, timeoutsFor } from '../src/lib/httpServer.js';
import { fetchWithTimeout } from '../src/lib/supabase.js';
import { memoryLogger, readyProbe, TEST_APP_KEY, testApp } from './helpers/app.js';

function limitedApp(limits: { RATE_LIMIT_MAX?: number; SUBMIT_RATE_LIMIT_MAX?: number }) {
  return createApp({
    config: {
      APP_API_KEY: TEST_APP_KEY,
      MAX_UPLOAD_BYTES: 1024 * 1024,
      RATE_LIMIT_WINDOW_MS: 60_000,
      ...limits,
    },
    readiness: readyProbe,
    logger: memoryLogger(),
  });
}

describe('security headers', () => {
  it('API responses carry hardening headers and are not cacheable', async () => {
    const { app } = testApp();
    const res = await request(app).get('/api/ping').set('X-App-Key', TEST_APP_KEY);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('error responses carry them too', async () => {
    const { app } = testApp();
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('CORS (browsers must not be able to use the API)', () => {
  it('no Access-Control-Allow-Origin on a cross-origin request', async () => {
    const { app } = testApp();
    const res = await request(app)
      .get('/api/ping')
      .set('Origin', 'https://evil.example')
      .set('X-App-Key', TEST_APP_KEY);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a browser preflight is not approved', async () => {
    const { app } = testApp();
    const res = await request(app)
      .options('/api/submissions')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-app-key');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-headers']).toBeUndefined();
  });
});

describe('rate limiting (per client IP)', () => {
  it('over the API limit → 429 rate_limited with Retry-After, standard error shape', async () => {
    const app = limitedApp({ RATE_LIMIT_MAX: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/ping').set('X-App-Key', TEST_APP_KEY)).status).toBe(200);
    }
    const res = await request(app).get('/api/ping').set('X-App-Key', TEST_APP_KEY);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(typeof res.body.requestId).toBe('string');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['ratelimit-policy']).toContain('3');
  });

  it('wrong-key requests count too (limits key guessing)', async () => {
    const app = limitedApp({ RATE_LIMIT_MAX: 2 });
    for (let i = 0; i < 2; i++) {
      expect((await request(app).get('/api/ping').set('X-App-Key', `guess-${i}`)).status).toBe(401);
    }
    expect((await request(app).get('/api/ping').set('X-App-Key', 'guess-3')).status).toBe(429);
  });

  it('different client IPs (behind the proxy) have separate budgets', async () => {
    const app = limitedApp({ RATE_LIMIT_MAX: 1 });
    const from = (ip: string) =>
      request(app).get('/api/ping').set('X-App-Key', TEST_APP_KEY).set('X-Forwarded-For', ip);
    expect((await from('203.0.113.1')).status).toBe(200);
    expect((await from('203.0.113.1')).status).toBe(429);
    expect((await from('203.0.113.2')).status).toBe(200);
  });

  it('health checks are never rate limited (platform probes)', async () => {
    const app = limitedApp({ RATE_LIMIT_MAX: 1 });
    for (let i = 0; i < 5; i++) expect((await request(app).get('/health')).status).toBe(200);
  });
});

describe('logs', () => {
  it('request logs never contain the client IP or the app key', async () => {
    const { app, logger } = testApp();
    await request(app).get('/api/ping').set('X-App-Key', TEST_APP_KEY).set('X-Forwarded-For', '198.51.100.77');
    const all = (logger as ReturnType<typeof memoryLogger>).lines.join('\n');
    expect(all).toContain('"path":"/ping"');
    expect(all).not.toContain('198.51.100.77');
    expect(all).not.toContain(TEST_APP_KEY);
  });
});

describe('configuration defaults (Milestone 8)', () => {
  const base = {
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-xxxxxxxx',
    APP_API_KEY: 'k'.repeat(40),
  };

  it('rate limits and timeouts have safe defaults', () => {
    const c = loadConfig(base);
    expect(c.RATE_LIMIT_MAX).toBe(30);
    expect(c.SUBMIT_RATE_LIMIT_MAX).toBe(6);
    expect(c.REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(c.SUPABASE_TIMEOUT_MS).toBe(20_000);
  });

  it('rejects a non-positive timeout', () => {
    expect(() => loadConfig({ ...base, REQUEST_TIMEOUT_MS: '0' })).toThrow(/REQUEST_TIMEOUT_MS/);
  });
});

describe('timeouts', () => {
  it('server: request / header / keep-alive timeouts are applied', () => {
    const server = createServer();
    applyTimeouts(server, timeoutsFor(120_000));
    expect(server.requestTimeout).toBe(120_000);
    expect(server.headersTimeout).toBe(30_000);
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(timeoutsFor(10_000).headersTimeoutMs).toBe(10_000);
  });

  it('Supabase calls are aborted after the configured time', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const f = fetchWithTimeout(30, hanging);
    await expect(f('https://x.supabase.co/rest/v1/t')).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it("Supabase calls keep the caller's own abort signal", async () => {
    const seen: AbortSignal[] = [];
    const ok = vi.fn<typeof fetch>(async (_input, init) => {
      seen.push(init!.signal!);
      return new Response('{}');
    });
    const caller = new AbortController();
    await fetchWithTimeout(10_000, ok)('https://x', { signal: caller.signal });
    caller.abort();
    expect(seen[0]!.aborted).toBe(true);
  });
});
