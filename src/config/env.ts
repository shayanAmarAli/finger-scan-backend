import { z } from 'zod';

/** Raised when the environment is missing or invalid. Never contains values. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const int = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  /** Server-side only. Must never be shipped in the Flutter app. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{2,62}$/)
    .default('fingerprints'),

  /** Shared key sent by the app in X-App-Key. */
  APP_API_KEY: z.string().min(32),

  MAX_UPLOAD_BYTES: int(15 * 1024 * 1024),
  RATE_LIMIT_WINDOW_MS: int(60_000),
  /** Requests per window per client IP, all /api routes. */
  RATE_LIMIT_MAX: int(30),
  /** Stricter limit for storing submissions (per window per client IP). */
  SUBMIT_RATE_LIMIT_MAX: int(6),
  /** Whole request must arrive within this (slow uploads are cut off). */
  REQUEST_TIMEOUT_MS: int(120_000),
  /** Each call to Supabase (database / storage) is aborted after this. */
  SUPABASE_TIMEOUT_MS: int(20_000),

  /** Run the cleanup job every N ms inside the server (0 = disabled). */
  CLEANUP_INTERVAL_MS: z.coerce.number().int().min(0).default(10 * 60_000),
  /** Pending submissions / unreferenced objects older than this are removed. */
  STALE_AFTER_MS: int(15 * 60_000),
});

export type Config = z.infer<typeof schema>;

/**
 * Validates environment variables. On failure throws [ConfigError] listing
 * which variables are wrong and why — never their values (they may be
 * secrets).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    const what =
      issue.code === 'invalid_type' && env[name] === undefined
        ? 'is required'
        : describe(issue);
    return `${name} ${what}`;
  });
  throw new ConfigError(problems);
}

function describe(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'too_small':
      return `is too short (minimum ${String(issue.minimum)})`;
    case 'invalid_format':
      return 'has an invalid format';
    case 'invalid_value':
      return 'has an invalid value';
    case 'invalid_type':
      return 'has an invalid type';
    default:
      return 'is invalid';
  }
}
