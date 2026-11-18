import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Admin CLI as a real process (no Supabase needed for these cases). */
function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/jobs/cli.ts', ...args], {
    cwd: join(import.meta.dirname, '..'),
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const env = {
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests-123',
  APP_API_KEY: 'k'.repeat(40),
};

describe('admin CLI', () => {
  it('refuses to run without configuration (no secrets printed)', () => {
    const r = cli(['cleanup'], { APP_API_KEY: 'short-secret' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SUPABASE_URL is required');
    expect(r.stderr).not.toContain('short-secret');
  });

  it('delete requires a valid submission UUID', () => {
    const r = cli(['delete', 'not-a-uuid'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage: npm run submission:delete');
  });

  it('unknown command → usage, exit 1', () => {
    const r = cli(['wipe-everything'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Commands: cleanup | delete');
  });
});
