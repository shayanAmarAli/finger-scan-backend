import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createSupabaseAdmin, supabaseReadiness } from './lib/supabase.js';

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
  const app = createApp({
    config,
    logger,
    readiness: supabaseReadiness(supabase, config.SUPABASE_STORAGE_BUCKET),
    version: process.env.npm_package_version ?? '0.1.0',
  });

  const server = app.listen(config.PORT, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.PORT;
    logger.info('listening', { port, env: config.NODE_ENV });
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
