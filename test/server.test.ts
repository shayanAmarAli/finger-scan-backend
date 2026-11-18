import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Starts the real server process (src/server.ts via tsx). */
function startServer(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, exited, out: () => stdout, err: () => stderr };
}

async function waitFor(check: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

const validEnv = {
  SUPABASE_URL: 'http://127.0.0.1:9', // unreachable on purpose
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests-123',
  APP_API_KEY: 'k'.repeat(40),
  PORT: '0',
};

describe('server process', () => {
  it('exits with code 1 on missing configuration, naming variables, no secrets', async () => {
    const s = startServer({ APP_API_KEY: 'too-short-secret' });
    expect(await s.exited).toBe(1);
    expect(s.err()).toContain('SUPABASE_URL is required');
    expect(s.err()).toContain('APP_API_KEY is too short');
    expect(s.err()).not.toContain('too-short-secret');
  });

  it('starts locally, serves /health, reports not-ready without Supabase, stops on SIGTERM', async () => {
    const s = startServer(validEnv);
    try {
      await waitFor(() => s.out().includes('"msg":"listening"'));
      const port = JSON.parse(s.out().split('\n').find((l) => l.includes('listening'))!).port;

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);

      const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        status: 'unavailable',
        checks: { database: false, storageBucket: false },
      });

      const unauth = await fetch(`http://127.0.0.1:${port}/api/ping`);
      expect(unauth.status).toBe(401);
      const auth = await fetch(`http://127.0.0.1:${port}/api/ping`, {
        headers: { 'X-App-Key': validEnv.APP_API_KEY },
      });
      expect(auth.status).toBe(200);

      expect(s.out()).not.toContain(validEnv.APP_API_KEY);
      expect(s.out()).not.toContain(validEnv.SUPABASE_SERVICE_ROLE_KEY);
    } finally {
      s.child.kill('SIGTERM');
      await s.exited;
    }
  });
});
