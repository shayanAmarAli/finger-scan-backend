import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { supabaseSubmissionRepository } from './db/submissionRepository.js';
import { createLogger } from './lib/logger.js';
import { createSupabaseAdmin, supabaseReadiness } from './lib/supabase.js';
import { defaultQualityConfig } from './quality/config.js';
import { CleanupService } from './services/cleanupService.js';
import { SubmissionService } from './services/submissionService.js';
import { supabaseObjectStore } from './storage/objectStore.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      // Names and problems only — never values.
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const logger = createLogger(config.LOG_LEVEL);
  const supabase = createSupabaseAdmin(config);
  const bucket = config.SUPABASE_STORAGE_BUCKET;
  const repo = supabaseSubmissionRepository(supabase);
  const store = supabaseObjectStore(supabase, bucket);

  const app = createApp({
    config,
    logger,
    readiness: supabaseReadiness(supabase, bucket),
    version: process.env.npm_package_version ?? '0.1.0',
    submissions: new SubmissionService({
      repo,
      store,
      bucket,
      qualityConfig: defaultQualityConfig,
      logger,
    }),
  });

  const server = app.listen(config.PORT, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.PORT;
    logger.info('listening', { port, env: config.NODE_ENV });
  });

  // Periodic, retryable cleanup of leftovers from failed uploads.
  let cleanupTimer: NodeJS.Timeout | undefined;
  if (config.CLEANUP_INTERVAL_MS > 0) {
    const cleanup = new CleanupService({ repo, store, bucket, logger, staleAfterMs: config.STALE_AFTER_MS });
    let running = false;
    cleanupTimer = setInterval(() => {
      if (running) return;
      running = true;
      cleanup
        .run()
        .catch((e: unknown) =>
          logger.warn('cleanup run failed', { error: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => (running = false));
    }, config.CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    if (cleanupTimer) clearInterval(cleanupTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
