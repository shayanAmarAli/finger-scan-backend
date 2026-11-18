import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { defaultQualityConfig } from '../src/quality/config.js';
import { memoryLogger, TEST_APP_KEY, testApp } from './helpers/app.js';
import { blurredJpeg, gif, jpeg, png } from './helpers/images.js';

const URL = '/api/fingerprints/quality-check';

function post(app: Parameters<typeof request>[0], image?: Buffer, opts: {
  hand?: string | null;
  contentType?: string;
  filename?: string;
  key?: string | null;
  field?: string;
} = {}) {
  let req = request(app).post(URL);
  if (opts.key !== null) req = req.set('X-App-Key', opts.key ?? TEST_APP_KEY);
  if (opts.hand !== null) req = req.field('hand', opts.hand ?? 'left');
  if (image) {
    req = req.attach(opts.field ?? 'image', image, {
      filename: opts.filename ?? 'photo.jpg',
      contentType: opts.contentType ?? 'image/jpeg',
    });
  }
  return req;
}

describe('POST /api/fingerprints/quality-check', () => {
  it('valid photo → 200 with quality results', async () => {
    const { app } = testApp();
    const res = await post(app, await jpeg(), { hand: 'right' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      passed: true,
      hand: 'right',
      qualityVersion: 'server-1.0',
      checks: {
        format: 'pass',
        resolution: 'pass',
        exposure: 'pass',
        sharpness: 'pass',
        fingerRegion: 'not_verified',
      },
      reasons: [],
      recommendations: [],
    });
    expect(res.body.metrics).toMatchObject({ format: 'jpeg', width: 1600, height: 1200 });
    expect(res.body.metrics.sharpnessScore).toBeGreaterThan(2);
    expect(res.body.metrics.brightnessScore).toBeGreaterThan(100);
  });

  it('PNG photo is accepted', async () => {
    const { app } = testApp();
    const res = await post(app, await png(), { contentType: 'image/png', filename: 'p.png' });
    expect(res.status).toBe(200);
    expect(res.body.metrics.format).toBe('png');
  });

  it('blurred image → passed:false with blur diagnostics', async () => {
    const { app } = testApp();
    const res = await post(app, await blurredJpeg());
    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(false);
    expect(res.body.checks.sharpness).toBe('fail');
    expect(res.body.reasons).toEqual(['Image appears blurry.']);
    expect(res.body.recommendations).toEqual([
      'Hold the camera steady and retake.',
      'Retake the photograph.',
    ]);
  });

  it('dark photo is detected (blur not judged when too dark)', async () => {
    const { app } = testApp();
    const res = await post(app, await jpeg({ luma: 38, ridges: 8 }));
    expect(res.body.passed).toBe(false);
    expect(res.body.checks.exposure).toBe('fail');
    expect(res.body.checks.sharpness).toBe('skipped');
    expect(res.body.reasons).toContain('Image is too dark.');
    expect(res.body.recommendations).toContain('Improve the lighting.');
  });

  it('bright photo with clipped highlights is detected', async () => {
    const { app } = testApp();
    const res = await post(app, await jpeg({ clippedShare: 0.25 }));
    expect(res.body.passed).toBe(false);
    expect(res.body.checks.exposure).toBe('fail');
    expect(res.body.metrics.clippedHighlightShare).toBeGreaterThan(0.05);
    expect(res.body.reasons).toContain('Image is overexposed or has strong glare.');
  });

  it('small image is rejected (resolution)', async () => {
    const { app } = testApp();
    const res = await post(app, await jpeg({ width: 800, height: 600 }));
    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(false);
    expect(res.body.checks.resolution).toBe('fail');
    expect(res.body.reasons[0]).toContain('800×600');
  });

  it('EXIF-rotated photo reports its displayed size', async () => {
    const { app } = testApp();
    const res = await post(app, await jpeg({}, 6));
    expect([res.body.metrics.width, res.body.metrics.height]).toEqual([1200, 1600]);
  });

  describe('rejected uploads', () => {
    it('corrupt file (truncated) → 422 corrupt_image', async () => {
      const { app } = testApp();
      const full = await jpeg({ width: 1600, height: 1200 });
      const res = await post(app, full.subarray(0, Math.floor(full.length / 2)));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('corrupt_image');
    });

    it('corrupt file (JPEG header + garbage) → 422', async () => {
      const { app } = testApp();
      const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7), Buffer.from([0xff, 0xd9])]);
      const res = await post(app, garbage);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('corrupt_image');
    });

    it('file-size limit is enforced → 413', async () => {
      const { app } = testApp({ maxUploadBytes: 10_000 });
      const res = await post(app, await jpeg());
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('file_too_large');
    });

    it('unsupported content (GIF) → 415, regardless of declared type', async () => {
      const { app } = testApp();
      const res = await post(app, await gif({ width: 64, height: 64 }), { contentType: 'image/jpeg' });
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('unsupported_format');
    });

    it('non-image content with an image extension → 415', async () => {
      const { app } = testApp();
      const res = await post(app, Buffer.from('<?php echo 1; ?>'), { filename: 'x.jpg' });
      expect(res.status).toBe(415);
    });

    it('declared MIME type not matching content → 415 mime_mismatch', async () => {
      const { app } = testApp();
      const res = await post(app, await jpeg(), { contentType: 'image/png' });
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('mime_mismatch');
    });

    it('missing image → 400', async () => {
      const { app } = testApp();
      const res = await post(app, undefined);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('missing_image');
    });

    it('missing or invalid hand → 400', async () => {
      const { app } = testApp();
      const img = await jpeg({ width: 64, height: 64 });
      for (const hand of [null, 'both', 'LEFT', '']) {
        const res = await post(app, img, { hand });
        expect(res.status, String(hand)).toBe(400);
        expect(res.body.error.code).toBe('invalid_hand');
      }
    });

    it('wrong field name or two files → 400', async () => {
      const { app } = testApp();
      const img = await jpeg({ width: 64, height: 64 });
      expect((await post(app, img, { field: 'photo' })).body.error.code).toBe('unexpected_file');
      const two = await request(app)
        .post(URL)
        .set('X-App-Key', TEST_APP_KEY)
        .field('hand', 'left')
        .attach('image', img, { filename: 'a.jpg', contentType: 'image/jpeg' })
        .attach('image', img, { filename: 'b.jpg', contentType: 'image/jpeg' });
      expect(two.status).toBe(400);
    });

    it('invalid or missing app key → 401 (upload not processed)', async () => {
      const { app, logger } = testApp();
      const img = await jpeg();
      expect((await post(app, img, { key: 'wrong' })).status).toBe(401);
      expect((await post(app, img, { key: null })).status).toBe(401);
      expect((logger as ReturnType<typeof memoryLogger>).lines.some((l) => l.includes('quality check'))).toBe(false);
    });
  });

  it('quality service exceptions → 500 with a safe message, logged', async () => {
    const logger = memoryLogger();
    const { app } = testApp({
      logger,
      assess: async () => {
        throw new Error('libvips: out of memory at 0x7fff');
      },
    });
    const res = await post(app, await jpeg({ width: 64, height: 64 }));
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: 'quality_check_failed',
      message: 'The image could not be checked. Please try again.',
    });
    expect(JSON.stringify(res.body)).not.toContain('libvips');
    expect(logger.lines.some((l) => l.includes('quality check failed'))).toBe(true);
  });

  it('never persists the image: nothing written to disk, nothing logged but metadata', async () => {
    const logger = memoryLogger();
    const { app } = testApp({ logger });
    const before = new Set(readdirSync(tmpdir()));
    const img = await jpeg();
    const res = await post(app, img);
    expect(res.status).toBe(200);
    // Memory storage only: no NEW temp file holds the image. (Other
    // processes, e.g. coverage workers, may create unrelated temp files,
    // so compare contents instead of counting entries.)
    const marker = img.subarray(200, 264);
    for (const name of readdirSync(tmpdir()).filter((n) => !before.has(n))) {
      const path = join(tmpdir(), name);
      let data: Buffer;
      try {
        if (!statSync(path).isFile()) continue;
        data = readFileSync(path);
      } catch {
        continue; // vanished or unreadable: not ours
      }
      expect(data.includes(marker), `temp file ${name} contains the image`).toBe(false);
    }
    const logs = logger.lines.join('\n');
    expect(logs).not.toContain(img.subarray(100, 140).toString('base64'));
    expect(logs.length).toBeLessThan(2000);
    // The quality route has no storage or database dependency at all
    // (createApp only gives it upload limits, thresholds and a logger).
  });

  it('thresholds are configurable per deployment', async () => {
    const { app } = testApp({ qualityConfig: { ...defaultQualityConfig, minSharpness: 0 } });
    const res = await post(app, await blurredJpeg());
    expect(res.body.passed).toBe(true);
  });
});
