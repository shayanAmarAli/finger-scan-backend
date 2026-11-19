import sharp from 'sharp';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '../src/lib/errors.js';
import { defaultQualityConfig } from '../src/quality/config.js';
import { CleanupService } from '../src/services/cleanupService.js';
import { SubmissionService, type SubmissionInput } from '../src/services/submissionService.js';
import { StorageError } from '../src/storage/objectStore.js';
import { memoryLogger } from './helpers/app.js';
import { InMemoryRepo, InMemoryStore } from './helpers/fakes.js';
import { blurredJpeg, fingerPixels, jpeg } from './helpers/images.js';

const BUCKET = 'fingerprints';
let LEFT: Buffer;
let RIGHT: Buffer;
let LEFT2: Buffer;
let BLURRY: Buffer;
let WITH_GPS: Buffer;

beforeAll(async () => {
  LEFT = await jpeg({ luma: 112 });
  RIGHT = await jpeg({ luma: 120 });
  LEFT2 = await jpeg({ luma: 128 });
  BLURRY = await blurredJpeg();
  const p = fingerPixels();
  WITH_GPS = await sharp(p.data, { raw: { width: p.width, height: p.height, channels: 3 } })
    .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '24/1 51/1 0/1' }, IFD0: { Make: 'TestPhone' } })
    .jpeg({ quality: 95 })
    .toBuffer();
});

let repo: InMemoryRepo;
let store: InMemoryStore;
let logger: ReturnType<typeof memoryLogger>;
let service: SubmissionService;
let ids: number;

beforeEach(() => {
  repo = new InMemoryRepo();
  store = new InMemoryStore();
  logger = memoryLogger();
  ids = 0;
  service = new SubmissionService({
    repo,
    store,
    bucket: BUCKET,
    qualityConfig: defaultQualityConfig,
    logger,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  });
});

const input = (key: string, left = LEFT, right = RIGHT): SubmissionInput => ({
  idempotencyKey: key,
  appVersion: '1.0.0+1',
  consentVersion: 'consent-2026-11',
  images: {
    left: { data: left, declaredMime: 'image/jpeg' },
    right: { data: right, declaredMime: 'image/jpeg' },
  },
});

async function expectAppError(p: Promise<unknown>, status: number, code: string): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(status);
    expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
  throw new Error(`expected ${status} ${code}`);
}

describe('first upload', () => {
  it('stores left and right privately and records both, complete', async () => {
    const r = await service.create(input('scan-0001'));
    expect(r).toMatchObject({ status: 'complete', replayed: false });
    const id = r.submissionId;

    expect(store.paths()).toEqual([`${id}/left.jpg`, `${id}/right.jpg`]);
    expect(store.objects.get(`${id}/left.jpg`)!.contentType).toBe('image/jpeg');
    expect(repo.submissions.get(id)).toMatchObject({ status: 'complete', appVersion: '1.0.0+1' });
    const imgs = repo.images.get(id)!;
    expect(imgs.map((i) => [i.hand, i.storage_path])).toEqual([
      ['left', `${id}/left.jpg`],
      ['right', `${id}/right.jpg`],
    ]);
    expect(imgs[0]).toMatchObject({
      mime_type: 'image/jpeg',
      width: 1600,
      height: 1200,
      quality_status: 'passed',
      quality_version: 'server-1.0',
    });
    expect(r.images!.map((i) => i.hand)).toEqual(['left', 'right']);
  });

  it('each hand is stored as its own image (left ≠ right content)', async () => {
    const { submissionId: id } = await service.create(input('scan-0002'));
    const left = store.objects.get(`${id}/left.jpg`)!.data;
    const right = store.objects.get(`${id}/right.jpg`)!.data;
    expect(left.equals(right)).toBe(false);
    expect((await sharp(left).stats()).channels[0]!.mean).toBeLessThan(
      (await sharp(right).stats()).channels[0]!.mean,
    );
  });

  it('a new scan never touches an earlier one', async () => {
    const first = await service.create(input('scan-a-0001'));
    const before = Buffer.from(store.objects.get(`${first.submissionId}/left.jpg`)!.data);
    const second = await service.create(input('scan-b-0001', LEFT2, RIGHT));
    expect(second.submissionId).not.toBe(first.submissionId);
    expect(store.objects.get(`${first.submissionId}/left.jpg`)!.data.equals(before)).toBe(true);
    expect(repo.images.get(first.submissionId)).toHaveLength(2);
    expect(repo.completeIds()).toHaveLength(2);
  });
});

describe('image fidelity and privacy', () => {
  it('strips GPS/camera metadata but keeps the pixels exactly', async () => {
    const { submissionId: id } = await service.create(input('scan-gps-01', WITH_GPS, RIGHT));
    const stored = store.objects.get(`${id}/left.jpg`)!.data;
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(stored.includes(Buffer.from('TestPhone'))).toBe(false);
    const a = await sharp(WITH_GPS).raw().toBuffer();
    const b = await sharp(stored).raw().toBuffer();
    expect(b.equals(a)).toBe(true);
  });
});

describe('rejections leave nothing behind', () => {
  it('low-quality image → 422 with per-hand diagnostics; nothing stored', async () => {
    const e = await expectAppError(service.create(input('scan-blur-1', LEFT, BLURRY)), 422, 'quality_failed');
    const q = e.details!.quality as Record<string, { passed: boolean; checks: { sharpness: string } }>;
    expect(q.left!.passed).toBe(true);
    expect(q.right!.passed).toBe(false);
    expect(q.right!.checks.sharpness).toBe('fail');
    expect(store.paths()).toEqual([]);
    expect(repo.submissions.size).toBe(0);
  });

  it('low-quality upload does not affect earlier submissions', async () => {
    const ok = await service.create(input('scan-good-1'));
    await expectAppError(service.create(input('scan-bad-1', BLURRY, RIGHT)), 422, 'quality_failed');
    expect(repo.completeIds()).toEqual([ok.submissionId]);
    expect(store.paths()).toHaveLength(2);
  });

  it('declared type not matching content → 415', async () => {
    const i = input('scan-mime-1');
    i.images.right.declaredMime = 'image/png';
    await expectAppError(service.create(i), 415, 'mime_mismatch');
    expect(repo.submissions.size).toBe(0);
  });

  it('invalid idempotency key → 400', async () => {
    for (const key of ['short', 'has space here', 'x'.repeat(129), 'semi;colon!']) {
      await expectAppError(service.create(input(key)), 400, 'invalid_idempotency_key');
    }
  });
});

describe('failures roll back completely', () => {
  it('storage upload failure → 503, database not updated, partial upload removed', async () => {
    store.faults.set('upload', (path) => (String(path).endsWith('right.jpg') ? new StorageError('boom') : undefined));
    await expectAppError(service.create(input('scan-up-fail')), 503, 'storage_unavailable');
    expect(store.paths()).toEqual([]); // left was uploaded, then removed
    expect(repo.submissions.size).toBe(0); // pending row removed
    expect(repo.images.size).toBe(0);
  });

  it('database failure at completion → 503, objects removed, no rows', async () => {
    repo.faults.set('complete', new Error('connection reset'));
    await expectAppError(service.create(input('scan-db-fail')), 503, 'database_unavailable');
    expect(store.paths()).toEqual([]);
    expect(repo.submissions.size).toBe(0);
  });

  it('database down before upload → 503, nothing uploaded', async () => {
    repo.faults.set('createPending', new Error('db down'));
    await expectAppError(service.create(input('scan-db-down')), 503, 'database_unavailable');
    expect(store.paths()).toEqual([]);
  });

  it('a failed attempt can be retried with the same key and then succeeds', async () => {
    repo.faults.set('complete', new Error('transient'), 1);
    await expectAppError(service.create(input('scan-retry-1')), 503, 'database_unavailable');
    const r = await service.create(input('scan-retry-1'));
    expect(r.replayed).toBe(false);
    expect(repo.completeIds()).toEqual([r.submissionId]);
    expect(store.paths()).toHaveLength(2);
  });

  it('if removing objects also fails, they are queued and the cleanup job removes them later', async () => {
    repo.faults.set('complete', new Error('db failure'));
    store.faults.set('remove', new StorageError('storage also down'), 1);
    await expectAppError(service.create(input('scan-orphan-1')), 503, 'database_unavailable');
    expect(store.paths()).toHaveLength(2); // orphans for now
    expect(repo.queue.map((q) => q.path).sort()).toEqual(store.paths());

    const report = await new CleanupService({ repo, store, bucket: BUCKET, logger }).run();
    expect(report.queueRemoved).toBe(2);
    expect(store.paths()).toEqual([]);
    expect(repo.queue).toEqual([]);
  });
});

describe('idempotency and concurrency', () => {
  it('retrying the same scan returns the same submission (no duplicate)', async () => {
    const a = await service.create(input('scan-idem-1'));
    const b = await service.create(input('scan-idem-1'));
    expect(b).toEqual({
      submissionId: a.submissionId,
      status: 'complete',
      replayed: true,
      accessToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(b.accessToken).not.toBe(a.accessToken);
    expect(repo.completeIds()).toEqual([a.submissionId]);
    expect(store.paths()).toHaveLength(2);
  });

  it('same key with different images → 422', async () => {
    await service.create(input('scan-idem-2'));
    await expectAppError(service.create(input('scan-idem-2', LEFT2, RIGHT)), 422, 'idempotency_key_reused');
    expect(repo.completeIds()).toHaveLength(1);
  });

  it('concurrent identical uploads result in ONE consistent submission', async () => {
    const results = await Promise.allSettled([
      service.create(input('scan-race-1')),
      service.create(input('scan-race-1')),
      service.create(input('scan-race-1')),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) expect((r.reason as AppError).code).toBe('submission_in_progress');

    expect(repo.submissions.size).toBe(1);
    expect(repo.completeIds()).toHaveLength(1);
    expect(store.paths()).toHaveLength(2);
    // After the dust settles a retry gets the same submission.
    const again = await service.create(input('scan-race-1'));
    expect(again.submissionId).toBe(repo.completeIds()[0]);
  });

  it('concurrent DIFFERENT scans are stored independently', async () => {
    const [a, b] = await Promise.all([
      service.create(input('scan-par-a')),
      service.create(input('scan-par-b', LEFT2, RIGHT)),
    ]);
    expect(a.submissionId).not.toBe(b.submissionId);
    expect(repo.completeIds()).toHaveLength(2);
    expect(store.paths()).toHaveLength(4);
  });
});

describe('logging', () => {
  it('never logs image data, metadata or the images’ quality details', async () => {
    await service.create(input('scan-log-1', WITH_GPS, RIGHT));
    repo.faults.set('complete', new Error('db failure'));
    await service.create(input('scan-log-2')).catch(() => {});
    const all = logger.lines.join('\n');
    expect(all).not.toContain(WITH_GPS.subarray(200, 260).toString('base64'));
    expect(all).not.toContain('TestPhone');
    expect(all).not.toContain('GPS');
    expect(all).not.toMatch(/sharpnessScore|brightnessScore/);
    expect(all.length).toBeLessThan(3000);
  });
});
