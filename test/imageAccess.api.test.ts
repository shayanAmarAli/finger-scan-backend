import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { defaultQualityConfig } from '../src/quality/config.js';
import { ImageAccessService } from '../src/services/imageAccessService.js';
import { hashAccessToken, SubmissionService } from '../src/services/submissionService.js';
import { memoryLogger, readyProbe, TEST_APP_KEY } from './helpers/app.js';
import { InMemoryRepo, InMemoryStore } from './helpers/fakes.js';
import { jpeg } from './helpers/images.js';

let LEFT: Buffer;
let RIGHT: Buffer;
beforeAll(async () => {
  LEFT = await jpeg({ luma: 112 });
  RIGHT = await jpeg({ luma: 120 });
});

let repo: InMemoryRepo;
let store: InMemoryStore;
let logger: ReturnType<typeof memoryLogger>;
let app: ReturnType<typeof createApp>;
let ids: string[];

beforeEach(() => {
  repo = new InMemoryRepo();
  store = new InMemoryStore();
  logger = memoryLogger();
  ids = [];
  app = createApp({
    config: { APP_API_KEY: TEST_APP_KEY, MAX_UPLOAD_BYTES: 15 * 1024 * 1024 },
    readiness: readyProbe,
    logger,
    submissions: new SubmissionService({
      repo,
      store,
      bucket: 'fingerprints',
      qualityConfig: defaultQualityConfig,
      logger,
      // Lets a test create two submissions sharing a short reference.
      newId: () => ids.shift() ?? crypto.randomUUID(),
    }),
    imageAccess: new ImageAccessService({ repo, store, logger }),
  });
});

function upload(idem = 'scan-0000-0001', left = LEFT, right = RIGHT) {
  return request(app)
    .post('/api/submissions')
    .set('X-App-Key', TEST_APP_KEY)
    .set('Idempotency-Key', idem)
    .field('consent_version', 'consent-2026-11')
    .attach('left', left, { filename: 'l.jpg', contentType: 'image/jpeg' })
    .attach('right', right, { filename: 'r.jpg', contentType: 'image/jpeg' });
}

function fetchImages(ref: string, token?: string | null, key: string | null = TEST_APP_KEY) {
  let r = request(app).get(`/api/submissions/${ref}/images`);
  if (key !== null) r = r.set('X-App-Key', key);
  if (token) r = r.set('X-Submission-Token', token);
  return r;
}

const shortRef = (id: string) => `${id.slice(0, 4)}-${id.slice(4, 8)}`.toUpperCase();

describe('access token on upload', () => {
  it('201 returns a 43-char URL-safe token; only its SHA-256 is stored', async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    const token: string = res.body.accessToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = repo.submissions.get(res.body.submissionId)!;
    expect(row.accessTokenHash).toBe(hashAccessToken(token));
    expect(JSON.stringify([...repo.submissions.values()])).not.toContain(token);
  });

  it('every submission gets a different token', async () => {
    const a = await upload('scan-aaaa-0001', LEFT, RIGHT);
    const b = await upload('scan-bbbb-0002', RIGHT, LEFT);
    expect(a.body.accessToken).not.toBe(b.body.accessToken);
  });

  it('a replay (same key + same photos) issues a NEW token and the old one stops working', async () => {
    const first = await upload();
    const replay = await upload();
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.accessToken).not.toBe(first.body.accessToken);

    expect((await fetchImages(first.body.submissionId, first.body.accessToken)).status).toBe(404);
    expect((await fetchImages(first.body.submissionId, replay.body.accessToken)).status).toBe(200);
  });
});

describe('GET /api/submissions/:ref/images', () => {
  it('owner (app key + token) gets metadata + short-lived signed URLs for both hands', async () => {
    const up = await upload();
    const res = await fetchImages(up.body.submissionId, up.body.accessToken);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.submissionId).toBe(up.body.submissionId);
    expect(res.body.expiresInSeconds).toBe(300);
    expect(res.body.images.map((i: { hand: string }) => i.hand)).toEqual(['left', 'right']);
    for (const img of res.body.images) {
      expect(img.url).toBe(`https://storage.test/sign/${up.body.submissionId}/${img.hand}.jpg?expires=300&token=signed`);
      expect(img).toMatchObject({ mimeType: 'image/jpeg', qualityStatus: 'passed' });
      expect(img.width).toBeGreaterThan(0);
      expect(img.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('works with the short reference shown in the app', async () => {
    const up = await upload();
    const res = await fetchImages(shortRef(up.body.submissionId), up.body.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.submissionId).toBe(up.body.submissionId);
  });

  it('two submissions sharing a reference: the token picks the right one', async () => {
    ids = ['3f2a9c1b-0000-4000-8000-000000000001', '3f2a9c1b-1111-4000-8000-000000000002'];
    const a = await upload('scan-aaaa-0001', LEFT, RIGHT);
    const b = await upload('scan-bbbb-0002', RIGHT, LEFT);
    const ra = await fetchImages('3F2A-9C1B', a.body.accessToken);
    const rb = await fetchImages('3F2A-9C1B', b.body.accessToken);
    expect(ra.body.submissionId).toBe(a.body.submissionId);
    expect(rb.body.submissionId).toBe(b.body.submissionId);
  });

  describe('refusals are indistinguishable (no probing which submissions exist)', () => {
    const NOT_FOUND = { code: 'not_found', message: 'Submission not found.' };

    it("another submission's token → 404", async () => {
      const a = await upload('scan-aaaa-0001', LEFT, RIGHT);
      const b = await upload('scan-bbbb-0002', RIGHT, LEFT);
      const res = await fetchImages(a.body.submissionId, b.body.accessToken);
      expect(res.status).toBe(404);
      expect(res.body.error).toEqual(NOT_FOUND);
    });

    it.each([
      ['no token', undefined],
      ['malformed token', 'short'],
      ['well-formed wrong token', 'A'.repeat(43)],
    ])('%s → 404', async (_name, token) => {
      const up = await upload();
      const res = await fetchImages(up.body.submissionId, token);
      expect(res.status).toBe(404);
      expect(res.body.error).toEqual(NOT_FOUND);
    });

    it('unknown id / garbage ref → the same 404', async () => {
      const up = await upload();
      for (const ref of ['00000000-0000-4000-8000-000000000000', '0000-0000', 'not-a-ref']) {
        const res = await fetchImages(ref, up.body.accessToken);
        expect(res.status).toBe(404);
        expect(res.body.error).toEqual(NOT_FOUND);
      }
    });

    it('a pending (unfinished) submission is never served', async () => {
      const up = await upload();
      repo.submissions.get(up.body.submissionId)!.status = 'pending';
      expect((await fetchImages(up.body.submissionId, up.body.accessToken)).status).toBe(404);
    });

    it('the token alone is not enough: the app key is still required', async () => {
      const up = await upload();
      expect((await fetchImages(up.body.submissionId, up.body.accessToken, null)).status).toBe(401);
      expect((await fetchImages(up.body.submissionId, up.body.accessToken, 'wrong-key')).status).toBe(401);
    });
  });

  it('after deletion the images are gone (404)', async () => {
    const up = await upload();
    repo.submissions.delete(up.body.submissionId);
    expect((await fetchImages(up.body.submissionId, up.body.accessToken)).status).toBe(404);
  });

  it('storage failure → 503, no internals leaked', async () => {
    const up = await upload();
    store.faults.set('signedUrl', new Error('bucket offline at 10.0.0.5'));
    const res = await fetchImages(up.body.submissionId, up.body.accessToken);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });

  it('database failure → 503', async () => {
    const up = await upload();
    repo.faults.set('findForAccess', new Error('connection reset'));
    expect((await fetchImages(up.body.submissionId, up.body.accessToken)).status).toBe(503);
  });

  it('tokens and signed URLs never appear in logs', async () => {
    const up = await upload();
    const res = await fetchImages(up.body.submissionId, up.body.accessToken);
    const logs = logger.lines.join('\n');
    expect(logs).toContain('submission images fetched');
    expect(logs).not.toContain(up.body.accessToken);
    expect(logs).not.toContain(res.body.images[0].url);
    expect(logs).not.toContain('token=signed');
  });

  it('fetching does not use up the stricter upload limit', async () => {
    const up = await upload();
    for (let i = 0; i < 8; i++) {
      expect((await fetchImages(up.body.submissionId, up.body.accessToken)).status).toBe(200);
    }
    expect((await upload('scan-cccc-0003', RIGHT, RIGHT)).status).toBe(201);
  });
});
