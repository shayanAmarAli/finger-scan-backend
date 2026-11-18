import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Config } from '../config/env.js';

/**
 * Server-side Supabase client using the service-role key. It bypasses Row
 * Level Security, so it must only ever run on the server; the Flutter app
 * never receives this key.
 */
export function createSupabaseAdmin(config: Config): SupabaseClient {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'X-Client-Info': 'finger-scan-backend' },
      fetch: fetchWithTimeout(config.SUPABASE_TIMEOUT_MS),
    },
  });
}

/**
 * fetch that aborts after [ms]: a hung database/storage call must not hold
 * the request (and the app's upload) forever. Keeps any caller signal.
 */
export function fetchWithTimeout(ms: number, base: typeof fetch = fetch): typeof fetch {
  return (input, init = {}) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}

/** Result of checking that Supabase is reachable and correctly set up. */
export interface ReadinessResult {
  ok: boolean;
  checks: { database: boolean; storageBucket: boolean };
}

export interface ReadinessProbe {
  check(): Promise<ReadinessResult>;
}

/**
 * Checks the database (the submissions table can be queried) and storage
 * (the bucket exists AND is private). Errors are swallowed into `false` so
 * no internal detail reaches API clients.
 */
export function supabaseReadiness(
  client: Pick<SupabaseClient, 'from' | 'storage'>,
  bucket: string,
): ReadinessProbe {
  return {
    async check() {
      let database = false;
      try {
        const { error } = await client
          .from('fingerprint_submissions')
          .select('id', { head: true, count: 'exact' })
          .limit(1);
        database = !error;
      } catch {
        database = false;
      }

      let storageBucket = false;
      try {
        const { data, error } = await client.storage.getBucket(bucket);
        storageBucket = !error && data !== null && data.public === false;
      } catch {
        storageBucket = false;
      }

      return { ok: database && storageBucket, checks: { database, storageBucket } };
    },
  };
}
