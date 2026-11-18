import { createHash, randomUUID } from 'node:crypto';

import { DuplicateKeyError, type ImageRecord, type SubmissionRepository } from '../db/submissionRepository.js';
import { stripMetadata } from '../images/stripMetadata.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { assessImage, ImageRejectedError, type QualityReport } from '../quality/assessImage.js';
import type { QualityConfig } from '../quality/config.js';
import { mimeTypeOf } from '../quality/imageFormat.js';
import type { ObjectStore } from '../storage/objectStore.js';

export type Hand = 'left' | 'right';
const HANDS: readonly Hand[] = ['left', 'right'];

export interface SubmissionInput {
  idempotencyKey: string;
  appVersion: string | null;
  images: Record<Hand, { data: Buffer; declaredMime: string }>;
}

export interface SubmissionResult {
  submissionId: string;
  status: 'complete';
  replayed: boolean;
  images?: { hand: Hand; width: number; height: number; sizeBytes: number; qualityStatus: 'passed' }[];
}

export interface SubmissionServiceDeps {
  repo: SubmissionRepository;
  store: ObjectStore;
  bucket: string;
  qualityConfig: QualityConfig;
  logger: Logger;
  assess?: (image: Buffer, config: QualityConfig) => Promise<QualityReport>;
  newId?: () => string;
}

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Stores one complete scan (left + right) — both images or neither.
 *
 * 1. Quality-check both images (nothing is stored if either fails).
 * 2. Strip metadata (GPS etc.) without re-encoding.
 * 3. Claim the Idempotency-Key by inserting a PENDING submission (unique
 *    key → concurrent duplicates collapse to one submission).
 * 4. Upload both objects to `<submissionId>/<hand>.<ext>` (no overwrite).
 * 5. Insert both image records + mark complete in ONE transaction.
 * Any failure after step 3 rolls back: uploaded objects are removed and the
 * pending row deleted; objects that cannot be removed are queued for the
 * cleanup job. Image bytes and metadata are never logged.
 */
export class SubmissionService {
  private readonly assess;
  private readonly newId;

  constructor(private readonly deps: SubmissionServiceDeps) {
    this.assess = deps.assess ?? assessImage;
    this.newId = deps.newId ?? randomUUID;
  }

  async create(input: SubmissionInput, requestId = '-'): Promise<SubmissionResult> {
    const { repo, store, bucket, logger } = this.deps;
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8–128 characters [A-Za-z0-9_-].');
    }

    // 1. Quality — both hands, before touching storage.
    const reports = {} as Record<Hand, QualityReport>;
    for (const hand of HANDS) {
      try {
        reports[hand] = await this.assess(input.images[hand].data, this.deps.qualityConfig);
      } catch (e) {
        if (e instanceof ImageRejectedError) {
          throw new AppError(
            e.code === 'unsupported_format' ? 415 : 422,
            e.code,
            `${capitalize(hand)} image: ${e.message}`,
          );
        }
        throw e;
      }
      const actual = mimeTypeOf[reports[hand].metrics.format];
      if (actual !== input.images[hand].declaredMime) {
        throw new AppError(415, 'mime_mismatch', `${capitalize(hand)} image: declared type does not match the content.`);
      }
    }
    const failed = HANDS.filter((h) => !reports[h].passed);
    if (failed.length > 0) {
      throw new AppError(
        422,
        'quality_failed',
        `Image quality check failed for: ${failed.join(', ')}.`,
        { quality: { left: reports.left, right: reports.right } },
      );
    }

    // 2. Metadata removal (no re-encoding).
    const cleaned = {} as Record<Hand, Buffer>;
    for (const hand of HANDS) {
      cleaned[hand] = stripMetadata(input.images[hand].data, reports[hand].metrics.format as 'jpeg' | 'png');
    }
    const requestHash = createHash('sha256')
      .update(input.images.left.data)
      .update('\0')
      .update(input.images.right.data)
      .digest('hex');

    // 3. Idempotency.
    const replay = await this.replayIfKnown(input.idempotencyKey, requestHash);
    if (replay) return replay;
    const id = this.newId();
    try {
      await repo.createPending({ id, idempotencyKey: input.idempotencyKey, requestHash, appVersion: input.appVersion });
    } catch (e) {
      if (e instanceof DuplicateKeyError) {
        // Lost a race with an identical concurrent request.
        const again = await this.replayIfKnown(input.idempotencyKey, requestHash);
        if (again) return again;
      }
      throw unavailable('database', e, logger, requestId);
    }

    // 4. Upload.
    const paths: Record<Hand, string> = {
      left: `${id}/left.${reports.left.metrics.format === 'png' ? 'png' : 'jpg'}`,
      right: `${id}/right.${reports.right.metrics.format === 'png' ? 'png' : 'jpg'}`,
    };
    const uploaded: string[] = [];
    try {
      for (const hand of HANDS) {
        await store.upload(paths[hand], cleaned[hand], input.images[hand].declaredMime);
        uploaded.push(paths[hand]);
      }
    } catch (e) {
      await this.rollback(id, uploaded, 'upload failed', requestId);
      throw unavailable('storage', e, logger, requestId);
    }

    // 5. Records + completion, atomically.
    const records: ImageRecord[] = HANDS.map((hand) => ({
      hand,
      storage_path: paths[hand],
      mime_type: input.images[hand].declaredMime as ImageRecord['mime_type'],
      width: reports[hand].metrics.width,
      height: reports[hand].metrics.height,
      size_bytes: cleaned[hand].length,
      quality_status: 'passed',
      quality_metrics: { ...reports[hand].metrics, checks: reports[hand].checks },
      quality_version: reports[hand].qualityVersion,
    }));
    try {
      await repo.complete(id, records);
    } catch (e) {
      await this.rollback(id, uploaded, 'database completion failed', requestId);
      throw unavailable('database', e, logger, requestId);
    }

    logger.info('submission stored', { requestId, submissionId: id });
    return {
      submissionId: id,
      status: 'complete',
      replayed: false,
      images: HANDS.map((hand) => ({
        hand,
        width: reports[hand].metrics.width,
        height: reports[hand].metrics.height,
        sizeBytes: cleaned[hand].length,
        qualityStatus: 'passed' as const,
      })),
    };
  }

  /** Returns the earlier result for a reused key, or null if unused. */
  private async replayIfKnown(key: string, requestHash: string): Promise<SubmissionResult | null> {
    let existing;
    try {
      existing = await this.deps.repo.findByIdempotencyKey(key);
    } catch (e) {
      throw unavailable('database', e, this.deps.logger, '-');
    }
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw new AppError(
        422,
        'idempotency_key_reused',
        'This Idempotency-Key was already used for different images. Use a new key for a new scan.',
      );
    }
    if (existing.status === 'pending') {
      throw new AppError(409, 'submission_in_progress', 'This submission is still being saved. Retry shortly.');
    }
    return { submissionId: existing.id, status: 'complete', replayed: true };
  }

  /** Undo a partial submission. Never throws. */
  private async rollback(id: string, uploaded: string[], reason: string, requestId: string): Promise<void> {
    const { repo, store, bucket, logger } = this.deps;
    if (uploaded.length > 0) {
      try {
        await store.remove(uploaded);
      } catch {
        try {
          await repo.enqueueCleanup(bucket, uploaded, `rollback: ${reason}`);
        } catch {
          // The cleanup job's orphan sweep will still find these objects.
          logger.error('rollback cleanup could not be queued', { requestId, submissionId: id });
        }
      }
    }
    try {
      await repo.deletePending(id);
    } catch {
      // Stale pending rows are removed by the cleanup job.
      logger.warn('pending submission not deleted during rollback', { requestId, submissionId: id });
    }
  }
}

function unavailable(what: 'database' | 'storage', cause: unknown, logger: Logger, requestId: string): AppError {
  if (cause instanceof AppError) return cause;
  logger.error(`${what} error`, {
    requestId,
    error: cause instanceof Error ? cause.message : String(cause),
  });
  return new AppError(503, `${what}_unavailable`, 'The submission could not be saved. Please try again.');
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
