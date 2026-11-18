import { Router } from 'express';

import { AppError } from '../lib/errors.js';
import { fileIn, imageUpload } from '../middleware/upload.js';
import type { Hand, SubmissionService } from '../services/submissionService.js';

/**
 * `POST /` — store one complete scan.
 *
 * Headers: `X-App-Key`, `Idempotency-Key` (8–128 chars; reuse it when
 * retrying the SAME scan, use a new one for a new scan).
 * Body (multipart): `left`, `right` (JPEG/PNG), `consent_version` (the
 * version of the consent text the user accepted; required), optional
 * `app_version`.
 *
 * 201 new submission · 200 replay of an earlier identical request.
 * There is intentionally no GET/DELETE: the API is write-only.
 */
const CONSENT_VERSION = /^[A-Za-z0-9._-]{1,50}$/;

export function submissionsRouter(service: SubmissionService, maxUploadBytes: number): Router {
  const router = Router();

  router.post('/', imageUpload(maxUploadBytes, ['left', 'right']), async (req, res) => {
    const idempotencyKey = req.get('idempotency-key');
    if (!idempotencyKey) {
      throw new AppError(400, 'missing_idempotency_key', 'Send an Idempotency-Key header.');
    }
    const images = {} as Record<Hand, { data: Buffer; declaredMime: string }>;
    for (const hand of ['left', 'right'] as const) {
      const file = fileIn(req, hand);
      if (!file || file.size === 0) {
        throw new AppError(400, 'missing_image', `Attach the ${hand}-hand photo in the "${hand}" field.`);
      }
      images[hand] = { data: file.buffer, declaredMime: file.mimetype };
    }
    const consentVersion: unknown = req.body?.consent_version;
    if (typeof consentVersion !== 'string' || !CONSENT_VERSION.test(consentVersion)) {
      throw new AppError(
        400,
        'consent_required',
        'Send consent_version: the version of the consent the user accepted.',
      );
    }
    const rawVersion = req.body?.app_version;
    const appVersion = typeof rawVersion === 'string' && rawVersion.length > 0 ? rawVersion.slice(0, 50) : null;

    const result = await service.create(
      { idempotencyKey, appVersion, consentVersion, images },
      req.id,
    );
    res.status(result.replayed ? 200 : 201).json(result);
  });

  return router;
}
