import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/env.js';
import { createSupabaseAdmin, supabaseReadiness } from '../src/lib/supabase.js';

type DbResult = { error: unknown };
type BucketResult = { data: { public: boolean } | null; error: unknown };

/** Fake of the two Supabase calls the readiness probe uses. */
function fakeClient(db: DbResult | Error, bucket: BucketResult | Error) {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      calls.push(`from:${table}`);
      return {
        select: () => ({
          limit: async () => {
            if (db instanceof Error) throw db;
            return db;
          },
        }),
      };
    },
    storage: {
      getBucket: async (id: string) => {
        calls.push(`bucket:${id}`);
        if (bucket instanceof Error) throw bucket;
        return bucket;
      },
    },
  };
  return { client: client as never, calls };
}

describe('supabaseReadiness', () => {
  it('ready when the table is queryable and the bucket exists and is private', async () => {
    const { client, calls } = fakeClient({ error: null }, { data: { public: false }, error: null });
    const r = await supabaseReadiness(client, 'fingerprints').check();
    expect(r).toEqual({ ok: true, checks: { database: true, storageBucket: true } });
    expect(calls).toEqual(['from:fingerprint_submissions', 'bucket:fingerprints']);
  });

  it('NOT ready if the bucket is public (misconfiguration)', async () => {
    const { client } = fakeClient({ error: null }, { data: { public: true }, error: null });
    const r = await supabaseReadiness(client, 'fingerprints').check();
    expect(r.ok).toBe(false);
    expect(r.checks.storageBucket).toBe(false);
  });

  it('database error → database false', async () => {
    const { client } = fakeClient(
      { error: { message: 'relation does not exist' } },
      { data: { public: false }, error: null },
    );
    const r = await supabaseReadiness(client, 'fingerprints').check();
    expect(r).toEqual({ ok: false, checks: { database: false, storageBucket: true } });
  });

  it('missing bucket → storageBucket false', async () => {
    const { client } = fakeClient({ error: null }, { data: null, error: { message: 'not found' } });
    const r = await supabaseReadiness(client, 'fingerprints').check();
    expect(r.checks.storageBucket).toBe(false);
  });

  it('network failures are contained (no throw)', async () => {
    const { client } = fakeClient(new Error('ECONNRESET'), new Error('ECONNRESET'));
    const r = await supabaseReadiness(client, 'fingerprints').check();
    expect(r).toEqual({ ok: false, checks: { database: false, storageBucket: false } });
  });
});

describe('createSupabaseAdmin', () => {
  it('creates a server-side client without session persistence', () => {
    const config = loadConfig({
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-1234567890',
      APP_API_KEY: 'a'.repeat(40),
    });
    const client = createSupabaseAdmin(config);
    expect(typeof client.from).toBe('function');
    expect(typeof client.storage.getBucket).toBe('function');
  });
});
