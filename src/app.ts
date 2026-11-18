import express, { Router, type Express } from 'express';

import type { Config } from './config/env.js';
import type { Logger } from './lib/logger.js';
import type { ReadinessProbe } from './lib/supabase.js';
import { requireAppKey } from './middleware/appKey.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';
import { defaultQualityConfig, type QualityConfig } from './quality/config.js';
import { fingerprintsRouter, type Assess } from './routes/fingerprints.js';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  config: Pick<Config, 'APP_API_KEY' | 'MAX_UPLOAD_BYTES'>;
  readiness: ReadinessProbe;
  logger: Logger;
  version?: string;
  qualityConfig?: QualityConfig;
  /** Override the image assessment (tests). */
  assess?: Assess;
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
}: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway terminates TLS in front of the app

  app.use(requestContext(logger));
  app.use(express.json({ limit: '16kb' })); // image uploads use multipart

  app.use('/health', healthRouter(readiness, version));

  // Everything under /api requires the app key.
  const api = Router();
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
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}
