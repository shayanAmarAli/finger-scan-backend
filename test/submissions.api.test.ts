import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { defaultQualityConfig } from '../src/quality/config.js';
import { SubmissionService } from '../src/services/submissionService.js';
import { StorageError } from '../src/storage/objectStore.js';
import { memoryLogger, readyProbe, TEST_APP_KEY } from './helpers/app.js';
import { InMemoryRepo, InMemoryStore } from './helpers/fakes.js';
import { blurredJpeg, gif, jpeg } from './helpers/images.js';

let LEFT: Buffer;
let RIGHT: Buffer;
let BLURRY: Buffer;
beforeAll(async () => {
  LEFT = await jpeg({ luma: 112 });
  RIGHT = await jpeg({ luma: 120 });
  BLURRY = await blurredJpeg();
});

let repo: InMemoryRepo;
let store: InMemoryStore;
let logger: ReturnType<typeof memoryLogger>;
let app: ReturnType<typeof createApp>;

function makeApp(maxUploadBytes = 15 * 1024 * 1024) {
  return createApp({
    config: { APP_API_KEY: TEST_APP_KEY, MAX_UPLOAD_BYTES: maxUploadBytes },
    readiness: readyProbe,
    logger,
    submissions: new SubmissionService({
      repo,
      store,
      bucket: 'fingerprints',
      qualityConfig: defaultQualityConfig,
      logger,
    }),
  });
}

beforeEach(() => {
  repo = new InMemoryRepo();
  store = new InMemoryStore();
  logger = memoryLogger();
  app = makeApp();
});

function submit(
  opts: {
    key?: string | null;
    idem?: string | null;
    left?: Buffer | null;
    right?: Buffer | null;
    rightType?: string;
    consent?: string | null;
    target?: ReturnType<typeof createApp>;
  } = {},
) {
  let r = request(opts.target ?? app).post('/api/submissions');
  if (opts.key !== null) r = r.set('X-App-Key', opts.key ?? TEST_APP_KEY);
  if (opts.idem !== null) r = r.set('Idempotency-Key', opts.idem ?? 'scan-0000-0001');
  r = r.field('app_version', '1.2.0');
  if (opts.consent !== null) r = r.field('consent_version', opts.consent ?? 'consent-2026-11');
  if (opts.left !== null) r = r.attach('left', opts.left ?? LEFT, { filename: 'l.jpg', contentType: 'image/jpeg' });
  if (opts.right !== null) {
    r = r.attach('right', opts.right ?? RIGHT, { filename: 'r.jpg', contentType: opts.rightType ?? 'image/jpeg' });
  }
  return r;
}

describe('POST /api/submissions', () => {
  it('missing consent → 400 consent_required, nothing stored', async () => {
    const res = await submit({ consent: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('consent_required');
    expect(repo.submissions.size).toBe(0);
  });

  it('malformed consent version → 400', async () => {
    const res = await submit({ consent: 'v1; drop table' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('consent_required');
  });

  it('the accepted consent version is recorded with the submission', async () => {
    const res = await submit({ consent: 'consent-2026-11' });
    expect(res.status).toBe(201);
    expect(repo.submissions.get(res.body.submissionId)!.consentVersion).toBe('consent-2026-11');
  });

  it('first upload → 201 with the new submission id; both hands stored', async () => {
    const res = await submit();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'complete', replayed: false });
    expect(res.body.submissionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.images).toEqual([
      expect.objectContaining({ hand: 'left', width: 1600, height: 1200, qualityStatus: 'passed' }),
      expect.objectContaining({ hand: 'right', width: 1600, height: 1200, qualityStatus: 'passed' }),
    ]);
    expect(store.paths()).toEqual([
      `${res.body.submissionId}/left.jpg`,
      `${res.body.submissionId}/right.jpg`,
    ]);
    expect(repo.submissions.get(res.body.submissionId)!.appVersion).toBe('1.2.0');
  });

  it('retry with the same Idempotency-Key → 200 replay, same id, nothing duplicated', async () => {
    const first = await submit();
    const again = await submit();
    expect(again.status).toBe(200);
    expect(again.body).toEqual({
      submissionId: first.body.submissionId,
      status: 'complete',
      replayed: true,
      accessToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(again.body.accessToken).not.toBe(first.body.accessToken); // rotated
    expect(store.paths()).toHaveLength(2);
  });

  it('same key, different images → 422 idempotency_key_reused', async () => {
    await submit();
    const res = await submit({ left: RIGHT, right: LEFT });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_key_reused');
  });

  it('low-quality image → 422 with per-hand quality feedback, nothing stored', async () => {
    const res = await submit({ right: BLURRY });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('quality_failed');
    expect(res.body.error.details.quality.right.passed).toBe(false);
    expect(res.body.error.details.quality.right.reasons).toEqual(['Image appears blurry.']);
    expect(res.body.error.details.quality.left.passed).toBe(true);
    expect(store.paths()).toEqual([]);
    expect(repo.submissions.size).toBe(0);
  });

  it('storage outage → 503, nothing half-saved', async () => {
    store.faults.set('upload', new StorageError('down'));
    const res = await submit();
    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'storage_unavailable',
      message: 'The submission could not be saved. Please try again.',
    });
    expect(repo.submissions.size).toBe(0);
    expect(store.paths()).toEqual([]);
  });

  describe('request validation', () => {
    it('missing app key → 401 (unauthorized upload)', async () => {
      expect((await submit({ key: null })).status).toBe(401);
      expect((await submit({ key: 'wrong' })).status).toBe(401);
      expect(store.paths()).toEqual([]);
    });

    it('missing Idempotency-Key → 400', async () => {
      const res = await submit({ idem: null });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('missing_idempotency_key');
    });

    it('malformed Idempotency-Key → 400', async () => {
      const res = await submit({ idem: 'bad key' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_idempotency_key');
    });

    it('missing left or right image → 400', async () => {
      expect((await submit({ right: null })).body.error.code).toBe('missing_image');
      expect((await submit({ left: null })).body.error.code).toBe('missing_image');
    });

    it('wrong image type (GIF content) → 415', async () => {
      const res = await submit({ right: await gif({ width: 64, height: 64 }) });
      expect(res.status).toBe(415);
      expect(res.body.error.message).toMatch(/^Right image:/);
    });

    it('each image is size-limited → 413', async () => {
      const res = await submit({ target: makeApp(50_000) });
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('file_too_large');
    });
  });

  it('write-only: there is no way to read or delete submissions over HTTP', async () => {
    const { body } = await submit();
    const id = body.submissionId as string;
    for (const [method, path] of [
      ['get', '/api/submissions'],
      ['get', `/api/submissions/${id}`],
      ['delete', `/api/submissions/${id}`],
      ['get', `/api/fingerprints/left`],
    ] as const) {
      const res = await request(app)[method](path).set('X-App-Key', TEST_APP_KEY);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it('no fingerprint data in logs', async () => {
    await submit();
    const all = logger.lines.join('\n');
    expect(all).not.toContain(LEFT.subarray(300, 360).toString('base64'));
    expect(all).not.toMatch(/sharpnessScore|brightnessScore|quality_metrics/);
    expect(all).toContain('submission stored');
  });
});
