import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config/env.js';

const valid = {
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-1234567890',
  APP_API_KEY: 'a'.repeat(40),
};

describe('loadConfig', () => {
  it('accepts a valid environment and applies defaults', () => {
    const c = loadConfig(valid);
    expect(c.SUPABASE_URL).toBe(valid.SUPABASE_URL);
    expect(c.PORT).toBe(8080);
    expect(c.NODE_ENV).toBe('development');
    expect(c.SUPABASE_STORAGE_BUCKET).toBe('fingerprints');
    expect(c.MAX_UPLOAD_BYTES).toBe(15 * 1024 * 1024);
    expect(c.LOG_LEVEL).toBe('info');
  });

  it('coerces numeric variables', () => {
    const c = loadConfig({ ...valid, PORT: '3000', RATE_LIMIT_MAX: '5' });
    expect(c.PORT).toBe(3000);
    expect(c.RATE_LIMIT_MAX).toBe(5);
  });

  it('missing configuration fails safely, naming every missing variable', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (e) {
      const err = e as ConfigError;
      expect(err.problems).toEqual(
        expect.arrayContaining([
          'SUPABASE_URL is required',
          'SUPABASE_SERVICE_ROLE_KEY is required',
          'APP_API_KEY is required',
        ]),
      );
    }
  });

  it('never echoes secret values in the error', () => {
    const secret = 'short-secret';
    try {
      loadConfig({ ...valid, APP_API_KEY: secret, SUPABASE_SERVICE_ROLE_KEY: 'tiny' });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('APP_API_KEY is too short');
      expect(msg).toContain('SUPABASE_SERVICE_ROLE_KEY is too short');
      expect(msg).not.toContain(secret);
      expect(msg).not.toContain('tiny');
    }
  });

  it('rejects an invalid URL, bad bucket name, bad numbers and enums', () => {
    const bad = {
      ...valid,
      SUPABASE_URL: 'not a url',
      SUPABASE_STORAGE_BUCKET: 'Bad Bucket!',
      PORT: '-1',
      NODE_ENV: 'staging',
    };
    try {
      loadConfig(bad);
      expect.unreachable();
    } catch (e) {
      const problems = (e as ConfigError).problems.join('\n');
      expect(problems).toMatch(/SUPABASE_URL/);
      expect(problems).toMatch(/SUPABASE_STORAGE_BUCKET/);
      expect(problems).toMatch(/PORT/);
      expect(problems).toMatch(/NODE_ENV/);
    }
  });

  it('requires an app key of at least 32 characters', () => {
    expect(() => loadConfig({ ...valid, APP_API_KEY: 'x'.repeat(31) })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, APP_API_KEY: 'x'.repeat(32) })).not.toThrow();
  });
});
