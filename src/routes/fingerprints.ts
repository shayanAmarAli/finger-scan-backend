import { Router } from 'express';

import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { fileIn, singleImageUpload } from '../middleware/upload.js';
import {
  assessImage as defaultAssess,
  ImageRejectedError,
  type QualityReport,
} from '../quality/assessImage.js';
import type { QualityConfig } from '../quality/config.js';
import { mimeTypeOf } from '../quality/imageFormat.js';

export type Assess = (image: Buffer, config: QualityConfig) => Promise<QualityReport>;

export interface FingerprintRouteDeps {
  maxUploadBytes: number;
  qualityConfig: QualityConfig;
  logger: Logger;
  assess?: Assess;
}

const HANDS = new Set(['left', 'right']);

/**
 * `POST /quality-check` — multipart `image` + `hand` (left|right).
 *
 * Validates and measures the image and returns diagnostics. It NEVER
 * stores the image: the bytes live only in memory for this request.
 */
export function fingerprintsRouter({
  maxUploadBytes,
  qualityConfig,
  logger,
  assess = defaultAssess,
}: FingerprintRouteDeps): Router {
  const router = Router();

  router.post('/quality-check', singleImageUpload(maxUploadBytes), async (req, res) => {
    const hand = typeof req.body?.hand === 'string' ? req.body.hand : undefined;
    if (!hand || !HANDS.has(hand)) {
      throw new AppError(400, 'invalid_hand', 'Field "hand" must be "left" or "right".');
    }
    const file = fileIn(req, 'image');
    if (!file || file.size === 0) {
      throw new AppError(400, 'missing_image', 'Attach the photo in the "image" field.');
    }

    let report: QualityReport;
    try {
      report = await assess(file.buffer, qualityConfig);
    } catch (e) {
      if (e instanceof ImageRejectedError) {
        throw e.code === 'unsupported_format'
          ? new AppError(415, 'unsupported_format', e.message)
          : new AppError(422, e.code, e.message);
      }
      logger.error('quality check failed', {
        requestId: req.id,
        error: e instanceof Error ? e.message : String(e),
      });
      throw new AppError(500, 'quality_check_failed', 'The image could not be checked. Please try again.');
    }

    // The declared type must match the actual content.
    const actualMime = mimeTypeOf[report.metrics.format];
    if (actualMime && file.mimetype !== actualMime) {
      throw new AppError(
        415,
        'mime_mismatch',
        `The file content is ${report.metrics.format.toUpperCase()} but was declared as ${file.mimetype}.`,
      );
    }

    logger.info('quality check', {
      requestId: req.id,
      hand,
      passed: report.passed,
      width: report.metrics.width,
      height: report.metrics.height,
    });
    res.json({ ...report, hand });
  });

  return router;
}
