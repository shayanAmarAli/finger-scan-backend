import express, { Router, type Express } from 'express';

import type { Config } from './config/env.js';
import type { Logger } from './lib/logger.js';
import type { ReadinessProbe } from './lib/supabase.js';
import { requireAppKey } from './middleware/appKey.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { noStore, rateLimiter, securityHeaders } from './middleware/security.js';
import { requestContext } from './middleware/requestContext.js';
import { defaultQualityConfig, type QualityConfig } from './quality/config.js';
import { fingerprintsRouter, type Assess } from './routes/fingerprints.js';
import { healthRouter } from './routes/health.js';
import { submissionsRouter } from './routes/submissions.js';
import type { ImageAccessService } from './services/imageAccessService.js';
import type { SubmissionService } from './services/submissionService.js';

export interface AppDeps {
  config: Pick<Config, 'APP_API_KEY' | 'MAX_UPLOAD_BYTES'> &
    Partial<Pick<Config, 'RATE_LIMIT_WINDOW_MS' | 'RATE_LIMIT_MAX' | 'SUBMIT_RATE_LIMIT_MAX'>>;
  readiness: ReadinessProbe;
  logger: Logger;
  version?: string;
  qualityConfig?: QualityConfig;
  /** Override the image assessment (tests). */
  assess?: Assess;
  /** Stores submissions; the route is mounted only when provided. */
  submissions?: SubmissionService;
  /** Lets the uploading app fetch its own images (needs `submissions`). */
  imageAccess?: ImageAccessService;
}

/**
 * Builds the Express app. Dependencies are injected so tests can run
 * without Supabase.
 */
export function createApp({
  config,
  readiness,
  logger,
  version = '0.1.0',
  qualityConfig = defaultQualityConfig,
  assess,
  submissions,
  imageAccess,
}: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway terminates TLS in front of the app

  app.use(requestContext(logger));
  app.use(securityHeaders());
  app.use(express.json({ limit: '16kb' })); // image uploads use multipart

  app.use('/health', healthRouter(readiness, version));

  // Everything under /api requires the app key.
  const windowMs = config.RATE_LIMIT_WINDOW_MS ?? 60_000;
  const api = Router();
  api.use(noStore);
  api.use(rateLimiter({ windowMs, max: config.RATE_LIMIT_MAX ?? 30, name: 'api' }));
  api.use(requireAppKey(config.APP_API_KEY));
  api.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  api.use(
    '/fingerprints',
    fingerprintsRouter({
      maxUploadBytes: config.MAX_UPLOAD_BYTES,
      qualityConfig,
      logger,
      ...(assess ? { assess } : {}),
    }),
  );
  if (submissions) {
    // The stricter limit applies to uploads only; fetching images counts
    // against the general /api limit.
    const submitLimit = rateLimiter({ windowMs, max: config.SUBMIT_RATE_LIMIT_MAX ?? 6, name: 'submissions' });
    api.use(
      '/submissions',
      (req, res, next) => (req.method === 'POST' ? submitLimit(req, res, next) : next()),
      submissionsRouter(submissions, config.MAX_UPLOAD_BYTES, imageAccess),
    );
  }
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}
