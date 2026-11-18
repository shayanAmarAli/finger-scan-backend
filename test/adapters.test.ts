import { describe, expect, it } from 'vitest';

import {
  DatabaseError,
  DuplicateKeyError,
  supabaseSubmissionRepository,
} from '../src/db/submissionRepository.js';
import { StorageError, supabaseObjectStore } from '../src/storage/objectStore.js';

/**
 * Thin checks of the Supabase adapters against a recording fake client:
 * correct tables/RPC/options, and error mapping. (Real Supabase behaviour is
 * covered by the migration tests on PostgreSQL and by manual validation.)
 */
type Result = { data?: unknown; error?: { code?: string; message: string } | null; count?: number };

function fakeDb(result: Result) {
  const calls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'delete', 'update', 'upsert', 'eq', 'lt', 'lte', 'gte', 'order', 'limit']) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return builder;
    };
  }
  builder.maybeSingle = async () => ({ data: result.data ?? null, error: result.error ?? null });
  builder.then = (resolve: (v: unknown) => void) =>
    resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count });
  const client = {
    from: (t: string) => {
      calls.push(['from', t]);
      return builder;
    },
    rpc: async (fn: string, args: unknown) => {
      calls.push(['rpc', fn, args]);
      return { error: result.error ?? null };
    },
  };
  return { client: client as never, calls };
}

describe('supabaseSubmissionRepository', () => {
  it('maps unique violations (23505) to DuplicateKeyError', async () => {
    const { client } = fakeDb({ error: { code: '23505', message: 'duplicate key value' } });
    await expect(
      supabaseSubmissionRepository(client).createPending({
        id: 'x', idempotencyKey: 'k', requestHash: 'h', appVersion: null, consentVersion: null,
      }),
    ).rejects.toBeInstanceOf(DuplicateKeyError);
  });

  it('maps other errors to DatabaseError', async () => {
    const { client } = fakeDb({ error: { code: '08006', message: 'connection failure' } });
    await expect(supabaseSubmissionRepository(client).complete('x', [])).rejects.toBeInstanceOf(DatabaseError);
  });

  it('finds ids by short reference with a uuid range query', async () => {
    const { client, calls } = fakeDb({ data: [{ id: '3f2a9c1b-0000-4000-8000-000000000001' }] });
    expect(await supabaseSubmissionRepository(client).idsWithPrefix('3f2a9c1b', 10)).toEqual([
      '3f2a9c1b-0000-4000-8000-000000000001',
    ]);
    expect(calls).toContainEqual(['gte', 'id', '3f2a9c1b-0000-0000-0000-000000000000']);
    expect(calls).toContainEqual(['lte', 'id', '3f2a9c1b-ffff-ffff-ffff-ffffffffffff']);
    expect(calls).toContainEqual(['limit', 10]);
  });

  it('completes via the atomic database function', async () => {
    const { client, calls } = fakeDb({});
    await supabaseSubmissionRepository(client).complete('sub-1', []);
    expect(calls).toContainEqual(['rpc', 'complete_fingerprint_submission', { p_submission_id: 'sub-1', p_images: [] }]);
  });

  it('reads a submission by idempotency key', async () => {
    const { client, calls } = fakeDb({
      data: { id: 's1', status: 'complete', request_hash: 'h', created_at: '2026-11-18T10:00:00Z' },
    });
    const row = await supabaseSubmissionRepository(client).findByIdempotencyKey('key-1');
    expect(row).toEqual({ id: 's1', status: 'complete', requestHash: 'h', createdAt: new Date('2026-11-18T10:00:00Z') });
    expect(calls).toContainEqual(['eq', 'idempotency_key', 'key-1']);
  });

  it('stale pending query filters by status and age', async () => {
    const { client, calls } = fakeDb({ data: [{ id: 'a' }, { id: 'b' }] });
    const cutoff = new Date('2026-11-18T10:00:00Z');
    expect(await supabaseSubmissionRepository(client).stalePending(cutoff, 50)).toEqual(['a', 'b']);
    expect(calls).toContainEqual(['eq', 'status', 'pending']);
    expect(calls).toContainEqual(['lt', 'created_at', cutoff.toISOString()]);
    expect(calls).toContainEqual(['limit', 50]);
  });

  it('cleanup queue: enqueue ignores duplicates; due items by next_attempt_at', async () => {
    const { client, calls } = fakeDb({ data: [{ id: 1, bucket: 'fingerprints', path: 'p', attempts: 0 }] });
    const repo = supabaseSubmissionRepository(client);
    await repo.enqueueCleanup('fingerprints', ['a.jpg', 'b.jpg'], 'rollback');
    expect(calls).toContainEqual([
      'upsert',
      [
        { bucket: 'fingerprints', path: 'a.jpg', reason: 'rollback' },
        { bucket: 'fingerprints', path: 'b.jpg', reason: 'rollback' },
      ],
      { onConflict: 'bucket,path', ignoreDuplicates: true },
    ]);
    const now = new Date('2026-11-18T10:00:00Z');
    expect(await repo.dueCleanup(10, now)).toHaveLength(1);
    expect(calls).toContainEqual(['lte', 'next_attempt_at', now.toISOString()]);
    await repo.enqueueCleanup('fingerprints', [], 'nothing'); // no request
    expect(calls.filter((c) => c[0] === 'upsert')).toHaveLength(1);
  });

  it('cleanup failure increments attempts and schedules the next try', async () => {
    const { client, calls } = fakeDb({ data: { attempts: 2 } });
    const next = new Date('2026-11-18T10:05:00Z');
    await supabaseSubmissionRepository(client).cleanupFailed(7, 'x'.repeat(900), next);
    const update = calls.find((c) => c[0] === 'update')!;
    expect(update[1]).toEqual({ attempts: 3, last_error: 'x'.repeat(500), next_attempt_at: next.toISOString() });
    expect(calls).toContainEqual(['eq', 'id', 7]);
  });

  it('exists / delete report whether a row was there', async () => {
    expect(await supabaseSubmissionRepository(fakeDb({ count: 1 }).client).exists('s1')).toBe(true);
    expect(await supabaseSubmissionRepository(fakeDb({ count: 0 }).client).exists('s1')).toBe(false);
    expect(await supabaseSubmissionRepository(fakeDb({ data: [{ id: 's1' }] }).client).delete('s1')).toBe(true);
    expect(await supabaseSubmissionRepository(fakeDb({ data: [] }).client).delete('s1')).toBe(false);
  });

  it('deletes only pending rows during rollback', async () => {
    const { client, calls } = fakeDb({});
    await supabaseSubmissionRepository(client).deletePending('s1');
    expect(calls).toContainEqual(['eq', 'status', 'pending']);
  });
});

describe('supabaseObjectStore', () => {
  function fakeStorage(result: { error?: { message: string } | null; data?: unknown }) {
    const calls: unknown[][] = [];
    const bucketApi = {
      upload: async (...a: unknown[]) => (calls.push(['upload', ...a]), { error: result.error ?? null }),
      remove: async (...a: unknown[]) => (calls.push(['remove', ...a]), { error: result.error ?? null }),
      list: async (...a: unknown[]) => (calls.push(['list', ...a]), { data: result.data ?? [], error: result.error ?? null }),
    };
    const client = { storage: { from: (b: string) => (calls.push(['from', b]), bucketApi) } };
    return { client: client as never, calls };
  }

  it('uploads privately without overwriting and without caching', async () => {
    const { client, calls } = fakeStorage({});
    await supabaseObjectStore(client, 'fingerprints').upload('s1/left.jpg', Buffer.from('x'), 'image/jpeg');
    expect(calls[0]).toEqual(['from', 'fingerprints']);
    expect(calls[1]![0]).toBe('upload');
    expect(calls[1]![3]).toEqual({ contentType: 'image/jpeg', upsert: false, cacheControl: 'no-store' });
  });

  it('maps storage errors to StorageError', async () => {
    const { client } = fakeStorage({ error: { message: 'The resource already exists' } });
    await expect(
      supabaseObjectStore(client, 'fingerprints').upload('p', Buffer.from('x'), 'image/jpeg'),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('lists object paths under a submission folder', async () => {
    const { client } = fakeStorage({ data: [{ id: '1', name: 'left.jpg' }, { id: '2', name: 'right.jpg' }] });
    expect(await supabaseObjectStore(client, 'fingerprints').list('s1')).toEqual(['s1/left.jpg', 's1/right.jpg']);
  });

  it('lists top-level folders with the age of their oldest object', async () => {
    const calls: unknown[][] = [];
    const listing: Record<string, unknown[]> = {
      '': [{ id: null, name: 'sub-a' }, { id: 'f', name: 'stray.jpg' }],
      'sub-a': [
        { id: '1', name: 'left.jpg', created_at: '2026-11-18T10:05:00Z' },
        { id: '2', name: 'right.jpg', created_at: '2026-11-18T10:00:00Z' },
      ],
    };
    const client = {
      storage: {
        from: () => ({
          list: async (prefix: string) => (calls.push(['list', prefix]), { data: listing[prefix] ?? [], error: null }),
        }),
      },
    };
    const folders = await supabaseObjectStore(client as never, 'fingerprints').listFolders(100);
    expect(folders).toEqual([{ name: 'sub-a', createdAt: new Date('2026-11-18T10:00:00Z') }]);
  });

  it('removing nothing makes no request', async () => {
    const { client, calls } = fakeStorage({});
    await supabaseObjectStore(client, 'fingerprints').remove([]);
    expect(calls).toEqual([]);
  });
});
