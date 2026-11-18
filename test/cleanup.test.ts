import { beforeEach, describe, expect, it } from 'vitest';

import { CleanupService, deleteSubmission } from '../src/services/cleanupService.js';
import { StorageError } from '../src/storage/objectStore.js';
import { memoryLogger } from './helpers/app.js';
import { InMemoryRepo, InMemoryStore } from './helpers/fakes.js';

const BUCKET = 'fingerprints';
const MIN = 60_000;

let repo: InMemoryRepo;
let store: InMemoryStore;
let clock: Date;
let cleanup: CleanupService;

beforeEach(() => {
  clock = new Date('2026-11-18T10:00:00Z');
  repo = new InMemoryRepo();
  store = new InMemoryStore();
  repo.now = () => clock;
  store.now = () => clock;
  cleanup = new CleanupService({
    repo,
    store,
    bucket: BUCKET,
    logger: memoryLogger(),
    staleAfterMs: 15 * MIN,
    now: () => clock,
  });
});

const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
const put = (path: string) => store.upload(path, Buffer.from('x'), 'image/jpeg');

async function completeSubmission(id: string) {
  await repo.createPending({ id, idempotencyKey: `key-${id}`, requestHash: 'a'.repeat(64), appVersion: null, consentVersion: null });
  await put(`${id}/left.jpg`);
  await put(`${id}/right.jpg`);
  await repo.complete(id, [
    { hand: 'left', storage_path: `${id}/left.jpg` } as never,
    { hand: 'right', storage_path: `${id}/right.jpg` } as never,
  ]);
}

describe('cleanup queue (retryable)', () => {
  it('removes queued objects and dequeues them', async () => {
    await put('s1/left.jpg');
    await repo.enqueueCleanup(BUCKET, ['s1/left.jpg'], 'rollback');
    const r = await cleanup.run();
    expect(r.queueRemoved).toBe(1);
    expect(store.paths()).toEqual([]);
    expect(repo.queue).toEqual([]);
  });

  it('failed removals are retried later with exponential backoff', async () => {
    await put('s1/left.jpg');
    await repo.enqueueCleanup(BUCKET, ['s1/left.jpg'], 'rollback');
    store.faults.set('remove', new StorageError('down'), 2);

    expect((await cleanup.run()).queueFailed).toBe(1);
    expect(repo.queue[0]).toMatchObject({ attempts: 1 });
    expect(repo.queue[0]!.nextAttemptAt.getTime() - clock.getTime()).toBe(1 * MIN);

    // Not due yet → untouched.
    expect((await cleanup.run()).queueFailed).toBe(0);

    advance(1 * MIN);
    await cleanup.run(); // second failure → 2 min backoff
    expect(repo.queue[0]).toMatchObject({ attempts: 2 });
    expect(repo.queue[0]!.nextAttemptAt.getTime() - clock.getTime()).toBe(2 * MIN);

    advance(2 * MIN);
    expect((await cleanup.run()).queueRemoved).toBe(1);
    expect(store.paths()).toEqual([]);
    expect(repo.queue).toEqual([]);
  });

  it('removing an already-gone object still succeeds (idempotent)', async () => {
    await repo.enqueueCleanup(BUCKET, ['gone/left.jpg'], 'rollback');
    expect((await cleanup.run()).queueRemoved).toBe(1);
  });
});

describe('stale pending submissions', () => {
  it('removes pending submissions older than the grace period with their objects', async () => {
    await repo.createPending({ id: 'stale', idempotencyKey: 'key-stale', requestHash: 'a'.repeat(64), appVersion: null, consentVersion: null });
    await put('stale/left.jpg');
    advance(16 * MIN);
    await repo.createPending({ id: 'fresh', idempotencyKey: 'key-fresh', requestHash: 'a'.repeat(64), appVersion: null, consentVersion: null });
    await put('fresh/left.jpg');

    const r = await cleanup.run();
    expect(r.stalePendingRemoved).toBe(1);
    expect(repo.submissions.has('stale')).toBe(false);
    expect(repo.submissions.has('fresh')).toBe(true); // may still be uploading
    expect(store.paths()).toEqual(['fresh/left.jpg']);
  });
});

describe('orphan folders', () => {
  it('removes old folders without a database row; keeps real and recent ones', async () => {
    await completeSubmission('real');
    await put('orphan-old/left.jpg');
    advance(20 * MIN);
    await put('orphan-new/left.jpg');

    const r = await cleanup.run();
    expect(r.orphanFoldersRemoved).toBe(1);
    expect(store.paths()).toEqual(['orphan-new/left.jpg', 'real/left.jpg', 'real/right.jpg']);
  });

  it('is safe to run repeatedly', async () => {
    await completeSubmission('real');
    advance(60 * MIN);
    await cleanup.run();
    await cleanup.run();
    expect(store.paths()).toEqual(['real/left.jpg', 'real/right.jpg']);
    expect(repo.completeIds()).toEqual(['real']);
  });
});

describe('deleteSubmission (admin)', () => {
  it('removes the stored objects and the database record', async () => {
    await completeSubmission('s1');
    await completeSubmission('s2');
    expect(await deleteSubmission({ repo, store, logger: memoryLogger() }, 's1')).toBe(true);
    expect(repo.submissions.has('s1')).toBe(false);
    expect(repo.images.has('s1')).toBe(false);
    expect(store.paths()).toEqual(['s2/left.jpg', 's2/right.jpg']);
  });

  it('deleted images are no longer accessible; repeating is safe', async () => {
    await completeSubmission('s1');
    await deleteSubmission({ repo, store, logger: memoryLogger() }, 's1');
    expect(await store.list('s1')).toEqual([]);
    expect(await deleteSubmission({ repo, store, logger: memoryLogger() }, 's1')).toBe(false);
  });

  it('storage failure keeps the record so the deletion can be retried', async () => {
    await completeSubmission('s1');
    store.faults.set('remove', new StorageError('down'), 1);
    await expect(deleteSubmission({ repo, store, logger: memoryLogger() }, 's1')).rejects.toThrow('down');
    expect(repo.submissions.has('s1')).toBe(true);
    await deleteSubmission({ repo, store, logger: memoryLogger() }, 's1');
    expect(repo.submissions.has('s1')).toBe(false);
    expect(store.paths()).toEqual([]);
  });
});
