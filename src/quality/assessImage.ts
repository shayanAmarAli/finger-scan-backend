import sharp, { type Metadata, type OutputInfo } from 'sharp';

import { analyzePixels } from './analyzePixels.js';
import { QUALITY_VERSION, type ImageFormat, type QualityConfig } from './config.js';
import { hasCompleteTrailer, sniffImageFormat } from './imageFormat.js';

export type CheckStatus = 'pass' | 'fail' | 'skipped' | 'not_verified';

export interface QualityReport {
  passed: boolean;
  qualityVersion: string;
  metrics: {
    format: ImageFormat;
    /** Displayed size in pixels (after EXIF orientation). */
    width: number;
    height: number;
    exifOrientation: number;
    sizeBytes: number;
    /** See PixelStats.sharpness. Higher = sharper. */
    sharpnessScore: number;
    /** Mean luma 0–255 of the analysed region. */
    brightnessScore: number;
    /** 0–1 share of clipped highlights on the finger candidate region. */
    clippedHighlightShare: number;
    /** 0–1 share of the central area that passed the skin-colour heuristic. */
    fingerCandidateShare: number;
    /** Sharp's own Laplacian-based sharpness estimate (informational). */
    sharpEstimate: number;
  };
  checks: {
    format: CheckStatus;
    resolution: CheckStatus;
    exposure: CheckStatus;
    sharpness: CheckStatus;
    /** Always `not_verified`: no reliable finger detector is available, so
     *  no claim is made about finger position or ridge visibility. */
    fingerRegion: 'not_verified';
  };
  reasons: string[];
  recommendations: string[];
}

/** Request-level problems (mapped to 4xx by the route). */
export class ImageRejectedError extends Error {
  constructor(
    readonly code: 'unsupported_format' | 'corrupt_image' | 'image_too_large',
    message: string,
    readonly format: ImageFormat,
  ) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

const RETAKE = 'Retake the photograph.';

/**
 * Validates and measures one uploaded image. Never stores or modifies it.
 *
 * Throws [ImageRejectedError] for unsupported, corrupt or oversized input;
 * otherwise returns a [QualityReport] (which may have `passed: false`).
 */
export async function assessImage(input: Buffer, config: QualityConfig): Promise<QualityReport> {
  const format = sniffImageFormat(input);
  if (!config.supportedFormats.includes(format)) {
    throw new ImageRejectedError(
      'unsupported_format',
      format === 'unknown'
        ? 'The file is not a recognised image.'
        : `The ${format.toUpperCase()} format is not supported. Use JPEG or PNG.`,
      format,
    );
  }
  if (!hasCompleteTrailer(input, format)) {
    throw new ImageRejectedError('corrupt_image', 'The image file is incomplete or damaged.', format);
  }

  const options = { limitInputPixels: config.maxInputPixels, failOn: 'error' as const };
  let meta: Metadata;
  try {
    meta = await sharp(input, options).metadata();
  } catch {
    throw new ImageRejectedError('corrupt_image', 'The image file could not be read.', format);
  }
  const storedW = meta.width ?? 0;
  const storedH = meta.height ?? 0;
  if (storedW * storedH > config.maxInputPixels) {
    throw new ImageRejectedError('image_too_large', 'The image has too many pixels.', format);
  }
  const orientation = meta.orientation ?? 1;
  const rotated = orientation >= 5 && orientation <= 8;
  const width = rotated ? storedH : storedW;
  const height = rotated ? storedW : storedH;

  let raw: { data: Buffer; info: OutputInfo };
  let sharpEstimate: number;
  try {
    const targetW = Math.max(1, Math.round(width * config.analysisScale));
    raw = await sharp(input, options)
      .rotate() // apply EXIF orientation
      .resize({ width: targetW, kernel: 'linear' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    sharpEstimate = (await sharp(input, options).stats()).sharpness;
  } catch {
    throw new ImageRejectedError('corrupt_image', 'The image file could not be decoded.', format);
  }

  const stats = analyzePixels(raw.data, raw.info.width, raw.info.height, config, raw.info.channels);

  const reasons: string[] = [];
  const recommendations: string[] = [];
  const add = (reason: string, recommendation: string) => {
    reasons.push(reason);
    if (!recommendations.includes(recommendation)) recommendations.push(recommendation);
  };

  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  const resolution: CheckStatus =
    shortSide >= config.minShortSidePx && longSide >= config.minLongSidePx ? 'pass' : 'fail';
  if (resolution === 'fail') {
    add(
      `Image resolution is too low (${width}×${height}; at least ${config.minLongSidePx}×${config.minShortSidePx} needed).`,
      'Use the rear camera at full resolution.',
    );
  }

  const tooDark = stats.brightness < config.minBrightness;
  const tooBright = stats.brightness > config.maxBrightness || stats.clippedShare > config.maxClippedShare;
  if (tooDark) add('Image is too dark.', 'Improve the lighting.');
  if (tooBright) add('Image is overexposed or has strong glare.', 'Avoid reflections on the fingertips.');
  const exposure: CheckStatus = tooDark || tooBright ? 'fail' : 'pass';

  // Blur is not judged on an image too dark to show detail.
  let sharpnessCheck: CheckStatus = 'skipped';
  if (!tooDark) {
    sharpnessCheck = stats.sharpness >= config.minSharpness ? 'pass' : 'fail';
    if (sharpnessCheck === 'fail') add('Image appears blurry.', 'Hold the camera steady and retake.');
  }

  const passed = reasons.length === 0;
  if (!passed && !recommendations.includes(RETAKE)) recommendations.push(RETAKE);

  return {
    passed,
    qualityVersion: QUALITY_VERSION,
    metrics: {
      format,
      width,
      height,
      exifOrientation: orientation,
      sizeBytes: input.length,
      sharpnessScore: round(stats.sharpness, 3),
      brightnessScore: round(stats.brightness, 1),
      clippedHighlightShare: round(stats.clippedShare, 4),
      fingerCandidateShare: round(stats.fingerCandidateShare, 3),
      sharpEstimate: round(sharpEstimate, 3),
    },
    checks: {
      format: 'pass',
      resolution,
      exposure,
      sharpness: sharpnessCheck,
      fingerRegion: 'not_verified',
    },
    reasons,
    recommendations,
  };
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));
