/**
 * An error that is safe to show to API clients. Anything else is reported
 * as a generic 500 without internal details.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra, client-safe structured information (e.g. quality reports). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static unauthorized(): AppError {
    return new AppError(401, 'unauthorized', 'Missing or invalid app key.');
  }

  static notFound(): AppError {
    return new AppError(404, 'not_found', 'Not found.');
  }

  static serviceUnavailable(message = 'A required service is unavailable.'): AppError {
    return new AppError(503, 'service_unavailable', message);
  }
}
