type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Minimal structured (JSON-line) logger.
 *
 * Rules: never pass request bodies, image data, headers or secrets in
 * `fields` — callers log only ids, routes, status codes and timings.
 */
export function createLogger(
  level: Level = 'info',
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const log = (lvl: Level) => (msg: string, fields: Record<string, unknown> = {}) => {
    if (order[lvl] < order[level]) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields }));
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = createLogger('error', () => {});
