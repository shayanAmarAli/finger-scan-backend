import { createApp, type AppDeps } from '../../src/app.js';
import { createLogger, type Logger } from '../../src/lib/logger.js';
import type { ReadinessProbe, ReadinessResult } from '../../src/lib/supabase.js';

export const TEST_APP_KEY = 'test-app-key-0123456789abcdef0123456789';

export const readyProbe: ReadinessProbe = {
  check: async () => ({ ok: true, checks: { database: true, storageBucket: true } }),
};

export function probe(result: ReadinessResult | Error): ReadinessProbe {
  return {
    check: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/** Captures log lines so tests can assert on (and against) their content. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return Object.assign(createLogger('debug', (l) => lines.push(l)), { lines });
}

export function testApp(
  opts: {
    readiness?: ReadinessProbe;
    logger?: Logger;
    maxUploadBytes?: number;
  } & Pick<AppDeps, 'qualityConfig' | 'assess'> = {},
) {
  const logger = opts.logger ?? memoryLogger();
  const app = createApp({
    config: { APP_API_KEY: TEST_APP_KEY, MAX_UPLOAD_BYTES: opts.maxUploadBytes ?? 15 * 1024 * 1024 },
    readiness: opts.readiness ?? readyProbe,
    logger,
    version: '9.9.9-test',
    ...(opts.qualityConfig ? { qualityConfig: opts.qualityConfig } : {}),
    ...(opts.assess ? { assess: opts.assess } : {}),
  });
  return { app, logger };
}
