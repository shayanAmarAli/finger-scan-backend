import { describe, expect, it } from 'vitest';

import { analyzePixels, isSkin } from '../src/quality/analyzePixels.js';
import { assessImage, ImageRejectedError } from '../src/quality/assessImage.js';
import { defaultQualityConfig, QUALITY_VERSION } from '../src/quality/config.js';
import { hasCompleteTrailer, sniffImageFormat } from '../src/quality/imageFormat.js';
import { blurredJpeg, fingerPixels, gif, jpeg, png } from './helpers/images.js';

const config = defaultQualityConfig;

describe('sniffImageFormat (content, not extension)', () => {
  it('detects formats from magic bytes', async () => {
    expect(sniffImageFormat(await jpeg({ width: 16, height: 16 }))).toBe('jpeg');
    expect(sniffImageFormat(await png({ width: 16, height: 16 }))).toBe('png');
    expect(sniffImageFormat(await gif({ width: 16, height: 16 }))).toBe('gif');
    expect(sniffImageFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImageFormat(Buffer.from('BM......'))).toBe('bmp');
    expect(sniffImageFormat(Buffer.from([0x49, 0x49, 0x2a, 0x00, 1]))).toBe('tiff');
    expect(sniffImageFormat(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0', 'latin1'))).toBe('heic');
    expect(sniffImageFormat(Buffer.from('hello'))).toBe('unknown');
    expect(sniffImageFormat(Buffer.alloc(0))).toBe('unknown');
  });

  it('detects truncated JPEG/PNG files', async () => {
    const j = await jpeg({ width: 32, height: 32 });
    const p = await png({ width: 32, height: 32 });
    expect(hasCompleteTrailer(j, 'jpeg')).toBe(true);
    expect(hasCompleteTrailer(j.subarray(0, j.length - 200), 'jpeg')).toBe(false);
    expect(hasCompleteTrailer(p, 'png')).toBe(true);
    expect(hasCompleteTrailer(p.subarray(0, p.length - 20), 'png')).toBe(false);
  });
});

describe('analyzePixels (pure statistics)', () => {
  const stats = (opts: Parameters<typeof fingerPixels>[0]) => {
    const p = fingerPixels({ width: 400, height: 300, ...opts });
    return analyzePixels(p.data, p.width, p.height, config);
  };

  it('skin test matches the app calibration', () => {
    expect(isSkin(110, 122, 144)).toBe(true); // fingertip
    expect(isSkin(150, 124, 130)).toBe(false); // beige desk
    expect(isSkin(20, 122, 144)).toBe(false); // too dark
  });

  it('sharp fingers: candidates used, brightness, sharpness', () => {
    const s = stats({});
    expect(s.usedFingerCandidates).toBe(true);
    expect(s.fingerCandidateShare).toBeGreaterThan(0.9);
    expect(s.brightness).toBeGreaterThan(105);
    expect(s.brightness).toBeLessThan(125);
    expect(s.sharpness).toBeGreaterThan(config.minSharpness);
  });

  it('smooth fingers → low sharpness', () => {
    expect(stats({ ridges: 0 }).sharpness).toBeLessThan(0.5);
  });

  it('glare patches are measured; a white background is not glare', () => {
    expect(stats({ clippedShare: 0.2 }).clippedShare).toBeCloseTo(0.2, 1);
    const p = fingerPixels({ width: 400, height: 300 });
    for (let y = 0; y < 300; y++) {
      for (let x = 200; x < 400; x++) p.data.fill(255, (y * 400 + x) * 3, (y * 400 + x) * 3 + 3);
    }
    expect(analyzePixels(p.data, 400, 300, config).clippedShare).toBeLessThan(0.05);
  });

  it('no skin → statistics over the whole central area', () => {
    const s = stats({ skin: false, luma: 140 });
    expect(s.usedFingerCandidates).toBe(false);
    expect(s.fingerCandidateShare).toBeLessThan(0.01);
    expect(s.brightness).toBeGreaterThan(135);
  });
});

describe('assessImage', () => {
  it('valid photo passes every check; fingerRegion is never claimed', async () => {
    const r = await assessImage(await jpeg(), config);
    expect(r.passed).toBe(true);
    expect(r.qualityVersion).toBe(QUALITY_VERSION);
    expect(r.checks).toEqual({
      format: 'pass',
      resolution: 'pass',
      exposure: 'pass',
      sharpness: 'pass',
      fingerRegion: 'not_verified',
    });
    expect(r.reasons).toEqual([]);
    expect(r.recommendations).toEqual([]);
    expect(r.metrics).toMatchObject({ format: 'jpeg', width: 1600, height: 1200, exifOrientation: 1 });
  });

  it('EXIF orientation: displayed size reported, verdict unchanged', async () => {
    const r = await assessImage(await jpeg({}, 6), config);
    expect(r.metrics.exifOrientation).toBe(6);
    expect([r.metrics.width, r.metrics.height]).toEqual([1200, 1600]);
    expect(r.passed).toBe(true);
  });

  it('PNG is accepted', async () => {
    expect((await assessImage(await png(), config)).passed).toBe(true);
  });

  it('rejects unsupported content with a typed error', async () => {
    await expect(assessImage(await gif({ width: 64, height: 64 }), config)).rejects.toMatchObject({
      code: 'unsupported_format',
      format: 'gif',
    });
    await expect(assessImage(Buffer.from('not an image'), config)).rejects.toBeInstanceOf(
      ImageRejectedError,
    );
  });

  it('rejects images with too many pixels (decompression bomb guard)', async () => {
    await expect(
      assessImage(await jpeg({ width: 400, height: 300 }), { ...config, maxInputPixels: 1000 }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/image_too_large|corrupt_image/) });
  });

  it('thresholds are configurable', async () => {
    const blurry = await blurredJpeg();
    expect((await assessImage(blurry, config)).checks.sharpness).toBe('fail');
    expect((await assessImage(blurry, { ...config, minSharpness: 0 })).passed).toBe(true);
    const small = await jpeg({ width: 800, height: 600 });
    expect((await assessImage(small, { ...config, minShortSidePx: 500, minLongSidePx: 700 })).passed).toBe(true);
  });
});
