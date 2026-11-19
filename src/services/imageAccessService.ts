import { timingSafeEqual } from 'node:crypto';

import type { SubmissionRepository } from '../db/submissionRepository.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { ObjectStore } from '../storage/objectStore.js';
import { parseSubmissionRef } from './reference.js';
import { hashAccessToken } from './submissionService.js';

/** Format of tokens issued by the submission service (32 random bytes). */
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface SubmissionImages {
  submissionId: string;
  /** Lifetime of each `url`, in seconds. */
  expiresInSeconds: number;
  images: {
    hand: 'left' | 'right';
    url: string;
    mimeType: string;
    width: number;
    height: number;
    sizeBytes: number;
    qualityStatus: string;
  }[];
}

export interface ImageAccessDeps {
  repo: Pick<SubmissionRepository, 'idsWithPrefix' | 'findForAccess' | 'imagesOf'>;
  store: Pick<ObjectStore, 'signedUrl'>;
  logger: Logger;
  /** Signed URL lifetime (default 5 minutes). */
  urlTtlSeconds?: number;
}

/**
 * Lets the uploading app fetch its own images: the caller must present the
 * submission's access token (the shared app key alone is not enough).
 *
 * Unknown submission, wrong token and unfinished upload all produce the
 * SAME 404, so the endpoint can't be used to discover which submissions
 * exist. Images are handed out as short-lived signed URLs; the bucket stays
 * private. Tokens and URLs are never logged.
 */
export class ImageAccessService {
  private readonly ttl: number;

  constructor(private readonly deps: ImageAccessDeps) {
    this.ttl = deps.urlTtlSeconds ?? 300;
  }

  async fetch(ref: string, token: string | undefined, requestId = '-'): Promise<SubmissionImages> {
    const parsed = parseSubmissionRef(ref);
    if (!parsed || !token || !ACCESS_TOKEN.test(token)) throw notFound();
    const { repo, store, logger } = this.deps;
    const presented = Buffer.from(hashAccessToken(token), 'hex');

    let submissionId: string | null = null;
    try {
      const candidates =
        parsed.kind === 'id' ? [parsed.id] : await repo.idsWithPrefix(parsed.prefix, 10);
      for (const id of candidates) {
        const row = await repo.findForAccess(id);
        if (!row || row.status !== 'complete' || !row.accessTokenHash) continue;
        if (timingSafeEqual(presented, Buffer.from(row.accessTokenHash, 'hex'))) {
          submissionId = row.id;
          break;
        }
      }
    } catch (e) {
      throw unavailable(e, logger, requestId);
    }
    if (!submissionId) throw notFound();

    try {
      const records = await repo.imagesOf(submissionId);
      const images = await Promise.all(
        records.map(async (r) => ({
          hand: r.hand,
          url: await store.signedUrl(r.storagePath, this.ttl),
          mimeType: r.mimeType,
          width: r.width,
          height: r.height,
          sizeBytes: r.sizeBytes,
          qualityStatus: r.qualityStatus,
        })),
      );
      logger.info('submission images fetched', { requestId, submissionId, images: images.length });
      return { submissionId, expiresInSeconds: this.ttl, images };
    } catch (e) {
      throw unavailable(e, logger, requestId);
    }
  }
}

const notFound = () => new AppError(404, 'not_found', 'Submission not found.');

function unavailable(cause: unknown, logger: Logger, requestId: string): AppError {
  if (cause instanceof AppError) return cause;
  logger.error('image access error', {
    requestId,
    error: cause instanceof Error ? cause.message : String(cause),
  });
  return new AppError(503, 'service_unavailable', 'The images could not be loaded. Please try again.');
}
